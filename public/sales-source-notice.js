(function () {
  "use strict";
  const labels = {
    gross_sales_yen: "売上（税込）",
    tax_amount_yen: "税額",
    guest_count: "客数",
    party_count: "組数",
  };
  const sources = {
    journal: "ジャーナル",
    receipt: "レシート",
    manual: "日別修正",
    mixed: "項目別採用",
  };
  const number = (n) => Number(n).toLocaleString("ja-JP");
  function node(tag, text) {
    const n = document.createElement(tag);
    if (text != null) n.textContent = text;
    return n;
  }
  function render(container, data, options) {
    if (!container) return;
    container.replaceChildren();
    container.style.cssText =
      "margin:16px 0;padding:16px;border:1px solid #64748b;border-radius:12px;overflow-wrap:anywhere;color:inherit";
    const days = Array.isArray(data?.series) ? data.series : [];
    const issues = days.filter((d) =>
      (d.source_differences || []).length || d.tax_needs_review
    );
    container.append(
      node(
        "strong",
        issues.length ? "⚠ 売上データに差異・確認事項があります" : "統一売上",
      ),
    );
    container.append(
      node(
        "p",
        "採用順：日別修正 → ジャーナル確定日計 → レシート。同じ日は足し合わせません。",
      ),
    );
    if (options?.showTotals !== false) {
      if (days.length || data?.monthly_fallbacks?.length) {
        const t = data.totals || {};
        container.append(
          node(
            "p",
            "売上（税込） " + number(t.gross_sales_yen) + "円 ／ 税抜 " +
              (t.net_sales_known === false
                ? "未確定"
                : number(t.net_sales_yen) + "円") +
              " ／ 客数 " + number(t.guest_count) + "人 ／ " +
              number(t.party_count) + "組",
          ),
        );
      } else {container.append(
          node(
            "p",
            "この期間の統一日別データは未登録です。原本・月次登録値とは区別して表示しています。",
          ),
        );}
      if (data?.monthly_fallbacks?.length) {
        container.append(
          node(
            "p",
            "日別未登録の月は月次登録値を使用：" +
              data.monthly_fallbacks.map((m) => m.month).join("、") +
              "。日別への推測配分はしません。",
          ),
        );
      }
    }
    container.append(
      node(
        "p",
        `照合済み ${
          days.filter((d) => d.journal_values && d.receipt_values).length
        }日 ／ 要確認 ${issues.length}日`,
      ),
    );
    if (issues.length) {
      container.style.borderColor = "#d97706";
      const details = node("details");
      details.append(
        node("summary", `日付・採用元・差額を確認（${issues.length}日）`),
      );
      const list = node("ul");
      list.style.cssText = "padding-left:20px;margin:12px 0";
      for (const d of issues) {
        const li = node(
          "li",
          `${d.date}：${sources[d.sales_source] || "項目別採用"}`,
        );
        for (const f of d.source_differences || []) {
          const unit = f.field.endsWith("_yen")
            ? "円"
            : f.field === "guest_count"
            ? "人"
            : "組";
          const adopted = sources[d.source_by_field?.[f.field]] || "統一値";
          li.append(
            node(
              "p",
              `${labels[f.field] || f.field}：ジャーナル ${
                number(f.journal)
              }${unit} ／ レシート ${number(f.receipt)}${unit} ／ 差 ${
                f.difference >= 0 ? "+" : ""
              }${number(f.difference)}${unit}（${adopted}を採用）`,
            ),
          );
        }
        if (d.tax_needs_review) {
          li.append(
            node(
              "p",
              "税込売上が手修正されています。税率を推測せず元の税額を保持しているため、税額も確認してください。",
            ),
          );
          if (options?.onTaxEdit) {
            const button = node("button", "税額を確認・修正");
            button.style.cssText = "min-height:44px;padding:8px 12px;color:inherit;background:transparent;border:1px solid #94a3b8;border-radius:8px;cursor:pointer";
            button.type = "button";
            button.onclick = () => options.onTaxEdit(d);
            li.append(button);
          }
        }
        list.append(li);
      }
      details.append(list);
      container.append(details);
    }
    if (data.generated_at) {
      container.append(
        node(
          "small",
          "確認時点：" + new Date(data.generated_at).toLocaleString("ja-JP"),
        ),
      );
    }
  }
  window.LINE_REPORT_SALES = { render };
})();
