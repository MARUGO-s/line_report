(function(root){
  'use strict';
  const validDate = s => /^\d{4}-\d{2}-\d{2}$/.test(s) && Number.isFinite(Date.parse(s)) && new Date(s).toISOString().slice(0,10) === s;
  const range = (from,to) => ({mode:'range',ranges:[{from,to}],label:from===to?from:from+'〜'+to});
  function resolvePeriod(text, now = new Date(), viewingDate = '') {
    const q = String(text || '').normalize('NFKC');
    const today = new Date(now.getTime()+9*3600000).toISOString().slice(0,10);
    const year = Number(today.slice(0,4)), month = Number(today.slice(5,7));
    const monthRange = (y,m) => {
      if(m<1 || m>12) return {error:'月は1〜12で指定してください。'};
      const from = y+'-'+String(m).padStart(2,'0')+'-01';
      return range(from,new Date(Date.UTC(y,m,0)).toISOString().slice(0,10));
    };
    if (/全期間|全データ|おまかせ|全部/.test(q)) return {mode:'all',ranges:[],label:'保存済み全期間'};
    if (/表示中|この日|その日/.test(q)) return validDate(viewingDate)?range(viewingDate,viewingDate):{error:'表示中の日がありません。年月または開始日・終了日を指定してください。'};
    const dates = [...q.matchAll(/(\d{4})[年\/-](\d{1,2})[月\/-](\d{1,2})日?/g)].map(m=>m[1]+'-'+m[2].padStart(2,'0')+'-'+m[3].padStart(2,'0'));
    const withoutFullDates=q.replace(/\d{4}[年\/-]\d{1,2}[月\/-]\d{1,2}日?/g,'');
    if(/\d{1,2}月\s*\d{1,2}日|(?:^|[^\d])\d{1,2}\/\d{1,2}(?![\d/])/.test(withoutFullDates)) return {error:'日付は年も含めて指定してください。例: 2026-06-01〜2026-06-15'};
    if(dates.length) {
      if(dates.length>2 || dates.some(d=>!validDate(d))) return {error:'有効な日付を1日、または開始日〜終了日で指定してください。'};
      if(dates.length===2 && /と|比較/.test(q) && !/から|〜|～|~/.test(q)) return {mode:'range',ranges:dates.map(day=>({from:day,to:day})),label:dates.join(' / ')};
      if(dates[0]>(dates[1]||dates[0])) return {error:'開始日は終了日以前にしてください。'};
      return range(dates[0],dates[1]||dates[0]);
    }
    if (/昨日|今日/.test(q)) {
      const day = /昨日/.test(q)?new Date(Date.parse(today)-86400000).toISOString().slice(0,10):today;
      return range(day,day);
    }
    const months = [...q.matchAll(/(?:(\d{4})年\s*)?(\d{1,2})月/g)];
    if(months.length) {
      if(months.length>2) return {error:'一度に比較できる月は2つです。'};
      const y = Number(months[0][1]||(/去年|昨年/.test(q)?year-1:year));
      const rows = months.map(m=>monthRange(Number(m[1]||y),Number(m[2])));
      if(rows.some(r=>r.error)) return rows.find(r=>r.error);
      const ranges = rows.flatMap(r=>r.ranges);
      if(ranges.length===2 && /から|〜|～|~/.test(q)) return range(ranges[0].from,ranges[1].to);
      return {mode:'range',ranges,label:rows.map(r=>r.label).join(' / ')};
    }
    const relative = [];
    if(/先月|前月/.test(q)) relative.push(monthRange(month===1?year-1:year,month===1?12:month-1));
    if(/今月/.test(q)) relative.push(range(today.slice(0,7)+'-01',today));
    if(relative.length) return {mode:'range',ranges:relative.flatMap(r=>r.ranges),label:relative.map(r=>r.label).join(' / ')};
    const isoMonth=q.match(/\b(\d{4})[-/](\d{1,2})(?![-/\d])/);
    if(isoMonth) return monthRange(Number(isoMonth[1]),Number(isoMonth[2]));
    if(/去年|昨年|今年/.test(q)) { const y=/去年|昨年/.test(q)?year-1:year; return range(y+'-01-01',y===year?today:y+'-12-31'); }
    if(/\d{1,2}\/\d{1,2}|\d+\s*(?:か|ヶ|ケ)月|直近\d+|過去\d+/.test(q)) return {error:'期間を年月または年を含む開始日〜終了日で指定してください。例: 2026-06-01〜2026-06-30'};
    return null;
  }
  // サーバー isKpiScenarioRequest と同じ基準。指標名だけで試算しない。
  function wantsKpiTargets(query) {
    const q = String(query || '').normalize('NFKC').toLowerCase();
    if (!q || /(?:試算|推測|推定|シミュレーション)(?:は|を)?(?:不要|しない|なし|やめ)|実績(?:だけ|のみ)/.test(q)) return false;
    const metric = /kpi|損益分岐|粗利|原価率|販売|売上|撤退|縮小|単価|価格|値付け|セット率|廃棄率|テイクアウト比率|新商品|導入|採算/;
    const simulation = /試算(?:して|する|を|したい|してください|しよう)|シミュレーション(?:して|する|を|したい)|シナリオ(?:を|で)|(?:試算|シミュレーション)$|試算してほしい/;
    if (metric.test(q) && simulation.test(q)) return true;
    if (/実績|推移|先月|昨年|去年|過去|実際|とは|意味|定義/.test(q)) return false;
    const plan = /目標|狙う|決めたい|設定(?:したい|して|する)|提案|値付け|単価設定|価格設定/;
    const numeric = /具体的な数字|数字で|数値で|定量|何個|いくつ売れ|何円に|いくらに|どれくらい/;
    return (metric.test(q) && plan.test(q)) ||
      (/損益分岐/.test(q) && /教えて|計算|何個|何円/.test(q)) ||
      (numeric.test(q) && /kpi|導入|新商品|採算|投資|回収/.test(q));
  }
  const initialState = () => ({period:null,pending:null,kpiConfirmed:false});
  function nextTurn(previous,text,options={}) {
    const state = {...previous};
    const raw = String(text||'').trim();
    const clarify = (message,choices=[]) => ({state,kind:'clarify',message,choices});
    if(/^(キャンセル|取り消し|やめる)$/.test(raw)) { state.pending=null; return {state,kind:'notice',message:'確認を取り消しました。別の質問を入力してください。'}; }
    let period = resolvePeriod(raw,options.now,options.viewingDate);
    if(period?.error) { state.pending={kind:'period',question:state.pending?.question||raw}; return clarify(period.error,['保存済み全期間']); }
    if(period?.ranges?.length) {
      const sorted=[...period.ranges].sort((a,b)=>a.from.localeCompare(b.from));
      if(sorted.some((r,i)=>r.from>r.to || (i>0 && r.from<=sorted[i-1].to)) || sorted.reduce((sum,r)=>sum+(Date.parse(r.to)-Date.parse(r.from))/86400000+1,0)>3660) {
        state.pending={kind:'period',question:state.pending?.question||raw};
        return clarify('開始日・終了日の順序と期間の重複を確認してください。合計3660日以内で指定できます。');
      }
    }
    let question = state.pending?.question || raw;
    if(state.pending?.kind==='kpi') {
      if(/^(保存済み前提・仮置きで進む|入力した前提で進む|おまかせ)$/.test(raw)) state.kpiConfirmed=true;
      else if(/分析|試算|教えて|[?？]/.test(raw)) { question=raw; state.pending=null; }
      else return clarify('試算前提の入力欄を確認してください。未入力は保存済み値、未登録なら仮置きになります。',['入力した前提で進む','保存済み前提・仮置きで進む','キャンセル']);
      period=state.period;
    } else if(state.pending?.kind==='period' && !period && /分析|試算|教えて|[?？]/.test(raw)) {
      question=raw;
    }
    if(period) state.period=period;
    if(!state.period || (state.pending?.kind==='period' && !period)) {
      state.pending={kind:'period',question};
      return clarify('どの期間を分析しますか？ 例「2026年6月」「2026年6月と7月を比較」「2026-06-01〜2026-06-15」。おまかせなら保存済み全期間です。',['保存済み全期間','今月','先月',...(options.viewingDate?['表示中の日']:[]),'キャンセル']);
    }
    if(wantsKpiTargets(question) && !state.kpiConfirmed && !options.assumptionsReady) {
      state.pending={kind:'kpi',question};
      return clarify('KPI試算の前提を確認します。売価・原価・焼成個数/回数・人員・廃棄許容率は分かりますか？ 下の「試算前提」に入力するか、保存済み値・仮置きで進められます。',['入力した前提で進む','保存済み前提・仮置きで進む','キャンセル']);
    }
    state.pending=null;
    return {state,kind:'ready',question,period:state.period};
  }
  root.FOODCOURT_QA_PLANNER={resolvePeriod,wantsKpiTargets,initialState,nextTurn};
})(globalThis);
