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
import sys, os, re, glob, json, argparse, datetime, unicodedata

PARSER_VERSION = "2026-08-30-v22"
ADJUSTMENT_ITEM_CODE = "__journal_adjustment__"

Z2H = str.maketrans("０１２３４５６７８９，．％／－", "0123456789,.%/-")

def znorm(s: str) -> str:
    return s.translate(Z2H)

def normalize_wide(s: str) -> str:
    """POS由来の全半角差を、検索とラベル集約用に正規化する。"""
    return unicodedata.normalize("NFKC", znorm(str(s or "")))

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
    m = re.search(r"[\\¥￥]\s*(-?[\d,]+)", normalize_wide(s))
    return int(m.group(1).replace(",", "")) if m else None

def first_int(s: str, unit: str):
    m = re.search(r"([\d,]+)\s*" + re.escape(unit), normalize_wide(s))
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
        z = normalize_wide(ln)
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
            if label in normalize_wide(ln):
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
ITEM_PRICE_RE = re.compile(
    r"@\s*([\d,]+)\s*x\s*(-?[\d,]+)\s+[\\¥￥]?\s*(-?[\d,]+)"
)
PAYMENT_LINE_RE = re.compile(
    r"^\s*計\s*\d+\s+(.+?)\s+[\\¥￥]\s*(-?[\d,]+)\s*$"
)
INVALID_SALE_STATUS_RE = re.compile(r"オーダーキャンセル|未会計オーダー取消|取引中止")

def normalize_payment_label(value: str) -> str:
    label = normalize_wide(value).strip()
    if not label:
        return ""
    if re.match(r"^現計", label):
        return "現金"
    if "クレジット" in label:
        return "クレジット"
    if "食べログ" in label:
        return "食べログ"
    if "一休" in label:
        return "一休"
    if "ぐるなび" in label:
        return "ぐるなび"
    if re.search(r"QR\s*コード", label, re.IGNORECASE):
        return "QRコード"
    if re.search(r"電子\s*マネ", label):
        return "電子マネー"
    if re.search(r"東京\s*ドーム\s*利", label):
        return "東京ドーム利用券"
    if re.search(r"ドーム\s*シティ\s*食事", label):
        return "ドームシティ食事券"
    if re.search(r"FOOD\s*STADIUM", label, re.IGNORECASE):
        return "FOODSTADIUM利用券"
    if re.search(r"TD\s*ポイント", label, re.IGNORECASE):
        return "TDポイントチケット"
    if re.match(r"^掛(?:計|支払|売)", label):
        return "掛売"
    return re.sub(r"計$", "", re.sub(r"[\s　]+", " ", label))[:30]

def parse_adjustment(lines, index):
    """割引/値引の次の非空行から、符号を失わず純額を返す。"""
    label = normalize_wide(lines[index]).strip()
    if label not in ("割引", "値引"):
        return None
    for following in lines[index + 1:]:
        normalized = normalize_wide(following).strip()
        if not normalized:
            continue
        match = re.search(r"[\\¥￥]?\s*(-?[\d,]+)\s*$", normalized)
        if match:
            value = int(match.group(1).replace(",", ""))
            if value:
                return {
                    "code": ADJUSTMENT_ITEM_CODE,
                    "name": label,
                    "unit": value,
                    "qty": 1,
                    "amount": value,
                    "category": "その他",
                    "isCharge": False,
                }
        return None
    return None

def parse_sale(rec):
    """完了会計から、支払・商品・取消調整を符号付きで抽出する。"""
    L = rec["lines"]
    text = "\n".join(L)
    normalized_text = normalize_wide(text)
    if INVALID_SALE_STATUS_RE.search(normalized_text):
        return None

    payment_breakdown = {}
    for ln in L:
        match = PAYMENT_LINE_RE.match(normalize_wide(ln))
        if not match:
            continue
        method = normalize_payment_label(match.group(1))
        value = int(match.group(2).replace(",", ""))
        if method:
            payment_breakdown[method] = payment_breakdown.get(method, 0) + value

    items=[]
    i=0
    while i < len(L):
        m = ITEM_CODE_RE.match(L[i])
        if m and i+1 < len(L):
            pm = ITEM_PRICE_RE.search(normalize_wide(L[i+1]))
            if pm:
                items.append({
                    "code": m.group(1), "name": m.group(2).strip(),
                    "unit": int(pm.group(1).replace(",","")),
                    "qty": int(pm.group(2).replace(",","")),
                    "amount": int(pm.group(3).replace(",","")),
                })
                i+=2; continue
        i+=1
    for i in range(len(L)):
        adjustment = parse_adjustment(L, i)
        if adjustment:
            items.append(adjustment)
    if not items:
        return None

    total=None; guests=None; table_no=""; change=0
    for ln in L:
        normalized = normalize_wide(ln)
        if re.search(r"合\s*計\s", normalized):
            a = amount(ln)
            if a is not None: total=a
        if re.search(r"お\s*釣", normalized):
            a = amount(ln)
            if a is not None: change=a
        g = first_int(ln, "名")
        if g is not None: guests=g
        table = re.search(
            r"(?:伝票\s*No\.?\s*[^\s]+\s+)?テーブル\s*No\.?\s*([^\s]+)",
            normalized,
        )
        if table:
            value = table.group(1).strip()
            if value and not value.startswith("保留") and value != ".":
                table_no = value
    nonzero_methods = [
        method for method, value in payment_breakdown.items() if value != 0
    ]
    if total is None and not nonzero_methods:
        return None
    pay = (
        nonzero_methods[0] if len(nonzero_methods) == 1
        else "複数" if len(nonzero_methods) > 1
        else "支払情報なし"
    )
    if change and "現金" in payment_breakdown:
        payment_breakdown["現金"] -= change
    if not payment_breakdown and total is not None and total > 0:
        payment_breakdown["支払情報なし"] = total
    void_match = re.search(r"★\s*VOID\s+No\.?\s*(\d+)", normalized_text, re.IGNORECASE)
    return {
        "no": rec["no"], "time": f"{rec['hh']:02d}:{rec['mi']:02d}",
        "pay": pay, "total": total, "guests": guests,
        **({"table_no": table_no} if table_no else {}),
        **({"void_ref": void_match.group(1)} if void_match else {}),
        "payment_breakdown": payment_breakdown,
        "items": items,
    }

def receipt_payments(receipt):
    """会計1件の支払方法別純額を返す。TS 側 resolvePosJournalReceiptPayments と同じ規則。

    内訳の合計が会計合計と一致しないときは推測配分せず、由来のわかる
    ラベル1本に寄せる。それも無ければ未捕捉として明示する。
    """
    total = int(receipt.get("total") or 0)
    if total <= 0:
        return {}
    normalized = {}
    for raw_label, raw_amount in (receipt.get("payment_breakdown") or {}).items():
        label = normalize_payment_label(raw_label) or str(raw_label)[:30]
        amount = int(raw_amount or 0)
        if not label or amount <= 0:
            continue
        normalized[label] = normalized.get(label, 0) + amount
    if normalized and sum(normalized.values()) == total:
        return normalized
    fallback = normalize_payment_label(receipt.get("pay")) or str(
        receipt.get("pay") or ""
    )[:30]
    if fallback and not re.match(r"^(?:複数|併用|その他|不明)$", fallback):
        return {fallback: total}
    return {"支払明細未捕捉": total}

def remove_voided_receipts(receipts):
    """取引変更(VOID)会計と、その取消対象の元会計を両方落とす。

    残すと日計と二重計上になる。TS 側 removeVoidedPosJournalReceipts と
    同じく、VOID から見て直前の未除外・同No.を1件だけ取り消す。
    """
    active = [True] * len(receipts)
    for index, receipt in enumerate(receipts):
        void_ref = str(receipt.get("void_ref") or "").strip()
        if not void_ref:
            continue
        active[index] = False
        for prior in range(index - 1, -1, -1):
            if not active[prior]:
                continue
            if str(receipts[prior].get("no") or "").strip() != void_ref:
                continue
            active[prior] = False
            break
    return [r for r, keep in zip(receipts, active) if keep]

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
    settle["receipts"] = remove_voided_receipts(receipts)
    settle["source"] = day.get("source")
    settle["parser_version"] = PARSER_VERSION
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
        day_pay={}
        for r in d["receipts"]:
            # 「複数」へ潰さず支払方法別の純額で積む。店舗ごとの任意区分
            # (電子マネー/QR/各種利用券)を既知5種に丸めると総額が合わない。
            for method, amt in receipt_payments(r).items():
                pay_agg.setdefault(method, {"count":0,"amount":0})
                pay_agg[method]["count"] += 1
                pay_agg[method]["amount"] += amt
                block = day_pay.setdefault(method, {"count":0,"amount":0})
                block["count"] += 1
                block["amount"] += amt
            for it in r["items"]:
                k=(it["code"], it["name"])
                e=item_rank.setdefault(k, {"code":it["code"],"name":it["name"],"qty":0,"amount":0})
                e["qty"]+=it["qty"]; e["amount"]+=it["amount"]
        d["payment_breakdown"]=day_pay
    ranking=sorted(item_rank.values(), key=lambda x:(-x["amount"], -x["qty"]))

    payment_total = sum(v["amount"] for v in pay_agg.values())

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
            "cash_amount": pay_agg.get("現金", {}).get("amount", 0),
            "credit_amount": pay_agg.get("クレジット", {}).get("amount", 0),
            "tabelog_amount": pay_agg.get("食べログ", {}).get("amount", 0),
            "ikyu_amount": pay_agg.get("一休", {}).get("amount", 0),
            "gurunavi_amount": pay_agg.get("ぐるなび", {}).get("amount", 0),
            "payment_total": payment_total,
            "unattributed_payment_amount": max(0, s("gross_sales") - payment_total),
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
    print("payment total:", result["totals"]["payment_total"],
          "unattributed:", result["totals"]["unattributed_payment_amount"])

if __name__ == "__main__":
    main()
