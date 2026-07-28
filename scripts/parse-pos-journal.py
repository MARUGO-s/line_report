#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
POS 電子ジャーナル(.lzh -> .jnl, ESC/POS + Shift-JIS)を解析し、
サイト表示用の JSON(public/pos-journal-202606.json 等)を生成する。

使い方:
  python3 scripts/parse-pos-journal.py <入力ディレクトリ(.lzh)> <出力JSONパス>
    [--month YYYY-MM] [--store 名称] [--store-key キー] [--store-code コード]
必要: pip install lhafile
"""
import sys, os, re, glob, json, argparse, datetime

Z2H = str.maketrans("０１２３４５６７８９，．％／－", "0123456789,.%/-")

def znorm(s: str) -> str:
    return s.translate(Z2H)

def strip_escpos(raw: bytes) -> str:
    out = bytearray(); i = 0; n = len(raw)
    while i < n:
        b = raw[i]
        if b in (0x1b, 0x1c):  # ESC / FS -> コマンド2バイトを破棄
            i += 3; continue
        out.append(b); i += 1
    return bytes(out).decode("cp932", "replace")

def decode_lzh(path: str):
    import lhafile
    a = lhafile.Lhafile(path)
    for name in a.namelist():
        yield name, strip_escpos(a.read(name))

HEADER_RE = re.compile(
    r"^\s*(\d{4}-\d{2})\s+No\.(\d+)\s+(\d{4})年\s*(\d+)月\s*(\d+)日\((.)\)\s*(\d+)時(\d+)分"
)

def amount(s: str):
    m = re.search(r"\\\s*([\d,]+)", znorm(s))
    return int(m.group(1).replace(",", "")) if m else None

def first_int(s: str, unit: str):
    m = re.search(r"([\d,]+)\s*" + unit, znorm(s))
    return int(m.group(1).replace(",", "")) if m else None

def split_records(text: str):
    lines = text.splitlines()
    recs = []; cur = None
    for ln in lines:
        m = HEADER_RE.match(ln)
        if m:
            if cur: recs.append(cur)
            cur = {
                "no": m.group(2),
                "y": int(m.group(3)), "mo": int(m.group(4)), "d": int(m.group(5)),
                "wd": m.group(6), "hh": int(m.group(7)), "mi": int(m.group(8)),
                "lines": [],
            }
        elif cur is not None:
            cur["lines"].append(ln)
    if cur: recs.append(cur)
    return recs

def val_near(lines, i, want_amt=True, unit=None, look=2):
    """label 行 i から下 look 行までで金額/数量を拾う。"""
    for j in range(i, min(i + look + 1, len(lines))):
        if want_amt:
            v = amount(lines[j])
            if v is not None: return v
        else:
            v = first_int(lines[j], unit)
            if v is not None: return v
    return None

def parse_settlement(rec):
    L = rec["lines"]
    out = {}
    # 営業日付
    for ln in L:
        m = re.search(r"営業日付[：:]\s*(\d{4})年\s*(\d+)月\s*(\d+)日", znorm(ln))
        if m:
            out["business_date"] = f"{int(m.group(1)):04d}-{int(m.group(2)):02d}-{int(m.group(3)):02d}"
            break
    labels_amt = {
        "net_sales": "純 売 上", "tax": "消 費 税", "gross_sales": "総 売 上",
        "avg_spend": "客単価", "discount_total": "★割引合計",
        "pay_total": "★支払合計",
        "tax_out": " 外税", "tax_in": " 内税",
    }
    for i, ln in enumerate(L):
        z = ln
        for key, lab in labels_amt.items():
            if lab in z and key not in out:
                v = amount(z)
                if v is None: v = val_near(L, i, True, look=1)
                if v is not None: out[key] = v
        if "会計組数・客数" in z:
            for j in range(i, min(i+3, len(L))):
                g = first_int(L[j], "組"); n = first_int(L[j], "名")
                if g is not None: out["groups"] = g
                if n is not None: out["guests"] = n
        if "店内飲食売上" in z:
            for j in range(i, min(i+3, len(L))):
                pt = first_int(L[j], "点"); am = amount(L[j])
                if pt is not None: out["dinein_items"] = pt
                if am is not None: out["dinein_sales"] = am
        # 決済方法別(回数+金額)
    def pay_block(label):
        for i, ln in enumerate(L):
            if label in ln:
                cnt=None; amt=None
                for j in range(i, min(i+3, len(L))):
                    c = first_int(L[j], "回")
                    a = amount(L[j])
                    if c is not None and cnt is None: cnt=c
                    if a is not None and amt is None: amt=a
                return {"count": cnt or 0, "amount": amt or 0}
        return {"count":0,"amount":0}
    out["pay_cash"] = pay_block("現計")
    out["pay_credit"] = pay_block("クレジット計")
    out["pay_tabelog"] = pay_block("食べログ")
    out["pay_ikyu"] = pay_block("一休")
    out["pay_gurunavi"] = pay_block("ぐるなび")
    return out

def parse_weather(rec):
    L = rec["lines"]; out={}
    for ln in L:
        z = znorm(ln)
        m = re.search(r"天候\s*([^\s　]+)", ln)
        if m and "天候" in ln and "入力" not in ln:
            w = m.group(1).strip("　 ")
            if w and w not in ("入力",): out["weather"] = w
        mt = re.search(r"気温\s*(\d+)", z)
        if mt: out["temp_c"] = int(mt.group(1))
    return out

ITEM_CODE_RE = re.compile(r"^\s{2}(\d{13})\s+(\S.*?)\s*$")
ITEM_PRICE_RE = re.compile(r"@\s*([\d,]+)\s*x\s*([\d,]+)\s+\\\s*([\d,]+)")

def parse_sale(rec):
    """完了会計(支払あり・キャンセル以外)から明細を抽出。"""
    L = rec["lines"]
    text = "\n".join(L)
    if "オーダーキャンセル" in text:
        return None
    # 支払方法を判定
    pay = None
    for ln in L:
        if re.search(r"計\s*\d+\s+現計", znorm(ln)): pay="現金"
        elif re.search(r"計\s*\d+\s+クレジット", ln): pay="クレジット"
        elif re.search(r"計\s*\d+\s+食べログ", ln): pay="食べログ"
        elif re.search(r"計\s*\d+\s+一休", ln): pay="一休"
        elif re.search(r"計\s*\d+\s+ぐるなび", ln): pay="ぐるなび"
    if pay is None:
        return None  # 会計未完了(保留/注文のみ)は集計しない
    items=[]
    i=0
    while i < len(L):
        m = ITEM_CODE_RE.match(L[i])
        if m and i+1 < len(L):
            pm = ITEM_PRICE_RE.search(znorm(L[i+1]))
            if pm:
                items.append({
                    "code": m.group(1), "name": m.group(2).strip(),
                    "unit": int(pm.group(1).replace(",","")),
                    "qty": int(pm.group(2).replace(",","")),
                    "amount": int(pm.group(3).replace(",","")),
                })
                i+=2; continue
        i+=1
    total=None
    for ln in L:
        if re.search(r"合\s*計\s", ln):
            a = amount(ln)
            if a is not None: total=a
    guests=None
    for ln in L:
        g = first_int(ln, "名")
        if g is not None: guests=g
    return {
        "no": rec["no"], "time": f"{rec['hh']:02d}:{rec['mi']:02d}",
        "pay": pay, "total": total, "guests": guests, "items": items,
    }

def parse_file(path):
    day = {"source": os.path.basename(path)}
    receipts=[]
    settle=None; weather={}
    for name, text in decode_lzh(path):
        day["inner"] = name
        recs = split_records(text)
        for rec in recs:
            body = "\n".join(rec["lines"])
            if "日計精算レポート" in body and settle is None:
                settle = parse_settlement(rec)
            elif "天候入力" in body:
                w = parse_weather(rec)
                weather.update({k:v for k,v in w.items() if v})
            else:
                s = parse_sale(rec)
                if s and s["items"]:
                    receipts.append(s)
    if settle is None:
        settle = {}
    settle.update(weather)
    settle["receipts"] = receipts
    settle["source"] = day.get("source")
    return settle

def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("indir")
    ap.add_argument("outjson")
    ap.add_argument("--month", default=None)
    ap.add_argument("--store", default="")
    ap.add_argument("--store-key", default="")
    ap.add_argument("--store-code", default="")
    args = ap.parse_args()

    files = sorted(glob.glob(os.path.join(args.indir, "*.lzh")))
    files = [f for f in files if not os.path.basename(f).startswith("._")]
    days=[]
    for f in files:
        try:
            d = parse_file(f)
            if d.get("business_date"):
                days.append(d)
        except Exception as e:
            print("WARN parse fail", f, e, file=sys.stderr)
    days.sort(key=lambda x: x["business_date"])

    # 集計
    def s(key): return sum((d.get(key) or 0) for d in days)
    item_rank={}
    pay_agg={}
    for d in days:
        for r in d["receipts"]:
            pay_agg.setdefault(r["pay"], {"count":0,"amount":0})
            pay_agg[r["pay"]]["count"] += 1
            pay_agg[r["pay"]]["amount"] += (r["total"] or 0)
            for it in r["items"]:
                k=(it["code"], it["name"])
                e=item_rank.setdefault(k, {"code":it["code"],"name":it["name"],"qty":0,"amount":0})
                e["qty"]+=it["qty"]; e["amount"]+=it["amount"]
    ranking=sorted(item_rank.values(), key=lambda x:(-x["amount"], -x["qty"]))

    month = args.month
    if not month and days:
        month = days[0]["business_date"][:7]

    result = {
        "meta": {
            "store_key": args.store_key or "",
            "store_name": args.store or "",
            "store_code": args.store_code or "",
            "month": month,
            "source_dir": os.path.abspath(args.indir),
            "file_count": len(files),
            "day_count": len(days),
            "generated_at": datetime.datetime.now().astimezone().isoformat(timespec="seconds"),
        },
        "totals": {
            "net_sales": s("net_sales"),
            "tax": s("tax"),
            "gross_sales": s("gross_sales"),
            "groups": s("groups"),
            "guests": s("guests"),
            "avg_spend": round(s("gross_sales")/s("guests")) if s("guests") else 0,
            "cash_amount": sum((d.get("pay_cash") or {}).get("amount",0) for d in days),
            "credit_amount": sum((d.get("pay_credit") or {}).get("amount",0) for d in days),
            "tabelog_amount": sum((d.get("pay_tabelog") or {}).get("amount",0) for d in days),
            "ikyu_amount": sum((d.get("pay_ikyu") or {}).get("amount",0) for d in days),
            "gurunavi_amount": sum((d.get("pay_gurunavi") or {}).get("amount",0) for d in days),
        },
        "payment_breakdown": pay_agg,
        "item_ranking": ranking,
        "days": days,
    }
    os.makedirs(os.path.dirname(os.path.abspath(args.outjson)), exist_ok=True)
    with open(args.outjson, "w", encoding="utf-8") as w:
        json.dump(result, w, ensure_ascii=False, indent=1)
    print("days:", len(days), "-> ", args.outjson)
    print("net_sales total:", result["totals"]["net_sales"], "gross:", result["totals"]["gross_sales"], "guests:", result["totals"]["guests"])

if __name__ == "__main__":
    main()
