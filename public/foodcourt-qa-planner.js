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
    if (/全期間|全データ/.test(q) || /^(?:おまかせ|全部)$/.test(q.trim())) return {mode:'all',ranges:[],label:'保存済み全期間'};
    // 「その日」は直前の回答を指す。画面で開いている別の日へ勝手に切り替えない。
    if (/表示中/.test(q)) return validDate(viewingDate)?range(viewingDate,viewingDate):{error:'表示中の日がありません。年月または開始日・終了日を指定してください。'};
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
  function wantsKpiTargets(query, historyText) {
    const q = String(query || '').normalize('NFKC').toLowerCase();
    const context = q + '\n' + String(historyText || '').normalize('NFKC').toLowerCase();
    if (!q || /(?:試算|推測|推定|シミュレーション)(?:は|を)?(?:不要|しない|なし|やめ)|実績(?:だけ|のみ)/.test(q)) return false;
    const metric = /kpi|損益分岐|粗利|原価率|販売|売上|撤退|縮小|単価|価格|値付け|セット率|廃棄率|テイクアウト比率|新商品|導入|採算/;
    const simulation = /試算(?:して|する|を|したい|してください|しよう)|シミュレーション(?:して|する|を|したい)|シナリオ(?:を|で)|(?:試算|シミュレーション)$|試算してほしい/;
    const productPlan = /新商品|導入|提案した(?:新)?商品|テスト販売|新しい施策|新施策|お出ししよう|売り出/;
    const salesPlan = /販売分析|販売戦略|販売見込み|売上見込み|売上予測|販売予測|目標販売|販売目標|kpi目標|kpi分析|kpiを分析|kpiで分析|売上貢献|上積み/;
    if (metric.test(q) && simulation.test(q)) return true;
    if (salesPlan.test(q) && (productPlan.test(q) || productPlan.test(context))) return true;
    if (/kpi/.test(q) && /分析/.test(q) && (productPlan.test(q) || productPlan.test(context) || /施策/.test(context))) return true;
    if (productPlan.test(q) && /分析/.test(q) && /目標|戦略|見込み|推測|予測|kpi|撤退|貢献|上積み/.test(q)) return true;
    if (/(?:とは|意味|定義)/.test(q) && !simulation.test(q) && !salesPlan.test(q)) return false;
    if (/(?:先月|昨年|去年|過去)の/.test(q) && /実績|廃棄|kpi/.test(q) && !simulation.test(q) && !productPlan.test(q) && !salesPlan.test(q)) return false;
    if (/達成状況|進捗|振り返|確認|評価/.test(q) && !salesPlan.test(q) && !simulation.test(q) && !productPlan.test(q)) return false;
    if (/推移/.test(q) && !productPlan.test(q) && !salesPlan.test(q) && !simulation.test(q) && !/目標|戦略|見込み/.test(q)) return false;
    if (/(?:新しい)?施策/.test(q) && /分析|kpi|目標|見込み|貢献|上積み|どれだけ|効果/.test(q)) return true;
    const plan = /目標.*(?:出して|出す|決め|設定|提案)|決めたい|設定(?:したい|して|する)|値付け|単価設定|価格設定/;
    const numeric = /具体的な数字|数字で|数値で|定量|何個|いくつ売れ|何円に|いくらに|どれくらい/;
    return (metric.test(q) && plan.test(q)) ||
      (/損益分岐/.test(q) && /教えて|計算|何個|何円/.test(q)) ||
      (numeric.test(q) && /kpi|導入|新商品|採算|投資|回収/.test(q)) ||
      (numeric.test(q) && /粗利|原価率/.test(q) && /狙う|目標|提案/.test(q));
  }
  const ANALYSIS_METHODS = [
    {id:'mix', label:'売上構成・主力商品'},
    {id:'decompose', label:'客数と客単価の分解'},
    {id:'timing', label:'時間帯・曜日'},
    {id:'bundle', label:'同時購入・併売'},
    {id:'event', label:'イベント・天気'},
    {id:'margin', label:'粗利・採算（未登録なら推測）'},
    {id:'kpi', label:'目標・損益分岐・撤退'},
    {id:'goal', label:'改善の打ち手'},
  ];
  const METHOD_ACTIONS = ['おすすめ全部で進む','ほかの手法を見る','この分析で進む','キャンセル'];
  const ASSUMPTION_ACTIONS = ['入力欄に書いて進む','全部お任せ','キャンセル'];
  const initialState = () => ({period:null,pending:null,kpiConfirmed:false,methods:null,assumptionsConfirmed:false,allowEstimate:false});
  function needsInputTrialChoice(query) {
    const q=String(query||'').normalize('NFKC');
    if(/試算.*(?:不要|なし|しない)|実績|推移|とは|意味|定義/.test(q)) return false;
    return /どう思|どうです|導入|新商品|提案|検討|しようと思|始めたい|売り?上げアップ/.test(q);
  }
  const trialChoices=['入力値で3シナリオを試算','入力値を使って分析のみ','キャンセル'];
  function isRestartQuestion(text) {
    return /最初から|やり直|し直して|新しく分析|全体を(?:もう一度)?分析|別の(?:テーマ|件|質問)で/.test(String(text||'').normalize('NFKC'));
  }
  function methodByChip(text) {
    const chip = String(text||'').replace(/^✓\s*/,'').trim();
    return ANALYSIS_METHODS.find(m => m.id===chip || m.label===chip) || null;
  }
  function recommendAnalysisMethods(question, historyText) {
    const q = String(question||'').normalize('NFKC');
    const ids = [];
    const add = id => { if(!ids.includes(id)) ids.push(id); };
    if (/売上|構成|主力|売れ筋|abc|商品|何が売/.test(q)) add('mix');
    if (/売上|客数|客単価|要因|分解|傾向/.test(q)) add('decompose');
    if (/時間帯|ピーク|曜日|朝|昼|夜|ランチ|ディナー/.test(q)) add('timing');
    if (/同時購入|併売|セット|一緒に/.test(q)) add('bundle');
    if (/イベント|天気|試合|ライブ|雨|ドーム/.test(q)) add('event');
    if (/粗利|原価|採算|利益|マージン/.test(q)) add('margin');
    if (/kpi|目標|損益分岐|撤退|見込み|予測|販売分析|販売戦略|施策|貢献|上積み/.test(q) || wantsKpiTargets(q, historyText)) add('kpi');
    if (/改善|打ち手|提案|どう思|導入|戦略|対策|施策/.test(q)) add('goal');
    if (!ids.length) { add('mix'); add('decompose'); add('event'); }
    return ids;
  }
  function methodsForceKpi(ids) {
    return (ids||[]).some(id => id==='kpi' || id==='margin');
  }
  function parsePriceCostFromText(text) {
    const t = String(text || '').normalize('NFKC');
    const out = {};
    const grab = (pattern, min, max, integer) => {
      const m = t.match(pattern);
      if (!m) return null;
      if (/[-−]\s*\d/.test(m[0]) || /[-−]$/.test(t.slice(0, m.index))) return null;
      const n = Number(String(m[1]).replace(/,/g, ''));
      if (!Number.isFinite(n) || n < min || n > max) return null;
      return integer ? Math.round(n) : n;
    };
    const unitPrice = grab(/(?:売価|単価|価格|定価|単品)[^0-9]{0,8}([0-9,]+(?:\.[0-9]+)?)\s*円/, 1, 100000, true);
    const unitCost = grab(/原価[^0-9]{0,8}([0-9,]+(?:\.[0-9]+)?)\s*円/, 0, 100000, true);
    const kgiMan = t.match(/(?:KGI|最終目標|月商|目標売上|売上目標)[^0-9]{0,12}([0-9,]+(?:\.[0-9]+)?)\s*万/);
    const kgiYen = grab(/(?:KGI|最終目標|月商|目標売上|売上目標)[^0-9]{0,12}([0-9,]+)\s*円/, 1, 100000000, true);
    const dailyGoal = grab(/(?:1|一)\s*日[^0-9]{0,16}([0-9,]+)\s*円/, 1, 100000000, true);
    const upliftGoal = grab(/上積み[^0-9]{0,8}([0-9,]+)\s*円/, 1, 100000000, true);
    const batchUnits = grab(/(?:1|一)\s*回[^0-9]{0,8}([0-9,]+)\s*(?:個|本|枚)/, 1, 2000, true);
    const batchesPerDay = grab(/(?:1|一)\s*日[^0-9]{0,12}?([0-9,]+)\s*回/, 1, 48, true);
    const staff = grab(/([0-9,]+(?:\.[0-9]+)?)\s*(?:人|名)/, 0.5, 50, false);
    const waste = grab(/廃棄[^0-9]{0,10}([0-9,]+(?:\.[0-9]+)?)\s*[%％]/, 0, 100, false);
    if (unitPrice != null) out.unitPriceYen = unitPrice;
    if (unitCost != null) out.unitCostYen = unitCost;
    if (batchUnits != null) out.bakeBatchUnits = batchUnits;
    if (batchesPerDay != null) out.bakeBatchesPerDay = batchesPerDay;
    if (staff != null) out.prepStaffCount = staff;
    if (waste != null) out.wasteRateTolerancePct = waste;
    if (kgiMan) {
      const n = Number(String(kgiMan[1]).replace(/,/g, ''));
      if (Number.isFinite(n) && n > 0) {
        out.kgiTargetYen = Math.round(n * 10000);
        out.kgiHorizon = /月商|月/.test(kgiMan[0]) || /月商/.test(t) ? 'month' : 'month';
      }
    } else if (kgiYen != null) {
      out.kgiTargetYen = kgiYen;
      out.kgiHorizon = /月商|月間|毎月/.test(t) ? 'month' : (/日/.test(t) ? 'day' : null);
    } else if (dailyGoal != null) {
      out.kgiTargetYen = dailyGoal;
      out.kgiHorizon = 'day';
    } else if (upliftGoal != null) {
      out.kgiTargetYen = upliftGoal;
      out.kgiHorizon = 'day';
    }
    return out;
  }
  function hasPriceAndCost(options) {
    return Boolean(options && options.hasUnitPrice && options.hasUnitCost);
  }
  function needsPriceCostInputs(question, historyText, methods) {
    const q = String(question || '').normalize('NFKC');
    if (!q) return false;
    if (/(?:試算|推測|推定|シミュレーション)(?:は|を)?(?:不要|しない|なし|やめ)|実績(?:だけ|のみ)/.test(q)) return false;
    if (/(?:とは|意味|定義)/.test(q) && !/試算|KPI|目標/.test(q)) return false;
    if (wantsKpiTargets(question, historyText)) return true;
    if (methodsForceKpi(methods)) return true;
    return false;
  }
  function assumptionsClarify(state, options) {
    const missing = [];
    if (!options?.hasUnitPrice) missing.push('想定売価（その商品1個の店頭価格）');
    if (!options?.hasUnitCost) missing.push('予想原価（1個あたり）');
    const list = missing.length ? missing.map(item => '・'+item).join('\n') : '・想定売価と予想原価';
    const message = 'この分析には、その商品自体の想定売価と予想原価が必要です。客単価や別商品の単価は使いません。\nまだ足りない項目:\n'+list+'\nあるとギャップ（KGI−現状）が計算できます:\n・最終目標KGI（期間と金額。例: 1日2000円上積み、月商50万円）\n下の「新商品・KPIの試算前提」に入力するか、チャットで「売価420円、原価126円、KGIは1日2000円」のように書いてください。分からなければ「全部お任せ」で、仮定(シナリオ)として仮置きします。KGIが空なら未設定のまま進め、達成率は作りません。';
    return {state,kind:'clarify',message,choices:[],actions:ASSUMPTION_ACTIONS};
  }
  function normalizeMethodIds(ids) {
    const allowed = new Set(ANALYSIS_METHODS.map(m => m.id));
    return [...new Set((ids||[]).filter(id => allowed.has(id)))];
  }
  function methodsClarify(state) {
    const pending = state.pending;
    const recommended = pending.recommended || [];
    const selected = pending.selected || [];
    const showAll = pending.showAll === true;
    const visible = showAll ? ANALYSIS_METHODS : ANALYSIS_METHODS.filter(m => recommended.includes(m.id) || selected.includes(m.id));
    const recLabels = ANALYSIS_METHODS.filter(m => recommended.includes(m.id)).map(m => m.label).join('、');
    const selLabels = selected.length
      ? ANALYSIS_METHODS.filter(m => selected.includes(m.id)).map(m => m.label).join('、')
      : 'まだありません（おすすめを使うか、手法を選んでください）';
    const choices = visible.map(m => (selected.includes(m.id)?'✓ ':'')+m.label);
    const actions = METHOD_ACTIONS.filter(action => showAll ? action!=='ほかの手法を見る' : true);
    return {state,kind:'clarify',message:'この質問には次の分析が向いています。使いたい手法を選んでください（複数可）。粗利が未登録でも、目標は推測値として出せます。\nおすすめ: '+recLabels+'\n選択中: '+selLabels,choices,actions};
  }
  function applySelectedMethods(state, ids) {
    const pendingRecommended = state.pending?.recommended || recommendAnalysisMethods(state.pending?.question || '', '');
    state.methods = normalizeMethodIds(ids);
    if (!state.methods.length) state.methods = pendingRecommended.slice();
    if (methodsForceKpi(state.methods)) state.kpiConfirmed = true;
    state.pending = null;
  }
  function nextTurn(previous,text,options={}) {
    const state = {...previous};
    const raw = String(text||'').trim();
    const clarify = (message,choices=[]) => ({state,kind:'clarify',message,choices});
    if(/^(キャンセル|取り消し|やめる)$/.test(raw)) { state.pending=null; return {state,kind:'notice',message:'確認を取り消しました。別の質問を入力してください。'}; }
    let heldQuestion = null;
    const assumptionChip = /^(全部お任せ|おまかせ|分からない|仮置きで進む|入力欄に書いて進む|入力した前提で進む)$/.test(raw);
    if(state.pending?.kind==='assumptions') {
      heldQuestion = state.pending.question;
      if(/^(全部お任せ|おまかせ|分からない|仮置きで進む)$/.test(raw)) {
        state.assumptionsConfirmed=true; state.allowEstimate=true; state.pending=null;
      } else if(/^(入力欄に書いて進む|入力した前提で進む)$/.test(raw)) {
        if(hasPriceAndCost(options)) { state.assumptionsConfirmed=true; state.allowEstimate=false; state.pending=null; }
        else return assumptionsClarify(state, options);
      } else if(hasPriceAndCost(options)) {
        state.assumptionsConfirmed=true; state.allowEstimate=false; state.pending=null;
      } else if(/分析|試算|教えて|[?？]/.test(raw) && !/売価|原価|円/.test(raw)) {
        heldQuestion = raw;
        state.pending=null;
        state.assumptionsConfirmed=false;
      } else {
        return assumptionsClarify(state, options);
      }
    }
    let period = assumptionChip ? null : resolvePeriod(raw,options.now,options.viewingDate);
    if(period?.error) { state.pending={kind:'period',question:state.pending?.question||raw}; return clarify(period.error,['保存済み全期間']); }
    if(period?.ranges?.length) {
      const sorted=[...period.ranges].sort((a,b)=>a.from.localeCompare(b.from));
      if(sorted.some((r,i)=>r.from>r.to || (i>0 && r.from<=sorted[i-1].to)) || sorted.reduce((sum,r)=>sum+(Date.parse(r.to)-Date.parse(r.from))/86400000+1,0)>3660) {
        state.pending={kind:'period',question:state.pending?.question||raw};
        return clarify('開始日・終了日の順序と期間の重複を確認してください。合計3660日以内で指定できます。');
      }
    }
    let question = heldQuestion || state.pending?.question || raw;
    let inputChoiceResolved=false;
    if(state.pending?.kind==='methods') {
      const picked = methodByChip(raw);
      if(picked) {
        const selected = new Set(state.pending.selected||[]);
        if(selected.has(picked.id)) selected.delete(picked.id); else selected.add(picked.id);
        state.pending={...state.pending,selected:[...selected]};
        return methodsClarify(state);
      }
      if(/^ほかの手法を見る$/.test(raw)) {
        state.pending={...state.pending,showAll:true};
        return methodsClarify(state);
      }
      if(/^(おすすめ全部で進む|入力値で3シナリオを試算)$/.test(raw)) {
        const extra = /入力値で3シナリオを試算/.test(raw) ? ['kpi'] : [];
        applySelectedMethods(state, [...(state.pending.recommended||[]), ...extra]);
      } else if(/^(この分析で進む|入力値を使って分析のみ|分析のみ|試算は不要)$/.test(raw)) {
        const selected = /分析のみ|試算は不要/.test(raw)
          ? (state.pending.selected||[]).filter(id => id!=='kpi' && id!=='margin')
          : (state.pending.selected||[]);
        applySelectedMethods(state, selected);
      } else if(/分析|試算|教えて|[?？]/.test(raw) && !period) {
        question=raw;
        state.pending={kind:'methods',question,recommended:recommendAnalysisMethods(question, options.historyText),selected:[],showAll:false};
        return methodsClarify(state);
      } else if(period) {
        state.period=period;
        return methodsClarify(state);
      } else {
        return methodsClarify(state);
      }
      period=period||state.period;
    } else if(state.pending?.kind==='kpi_use') {
      if(/^(入力値で3シナリオを試算|はい|お願いします)$/.test(raw)) {
        question='新商品のKPIを保守・標準・強気の3シナリオで試算してください。\n元の相談: '+question;
        state.kpiConfirmed=true; inputChoiceResolved=true; state.pending=null;
        state.methods = normalizeMethodIds([...(state.methods||[]),'kpi']);
      } else if(/^(入力値を使って分析のみ|分析のみ|試算は不要|いいえ)$/.test(raw)) {
        inputChoiceResolved=true; state.pending=null;
      } else if(/分析|試算|教えて|[?？]/.test(raw)) { question=raw; state.pending=null; }
      else return clarify('入力した前提で数値試算も行いますか？ 分析のみなら入力値は参照しますが、新しい目標数値は作りません。',trialChoices);
      period=period||state.period;
    } else if(state.pending?.kind==='kpi') {
      if(/^(保存済み前提・仮置きで進む|入力した前提で進む|おまかせ)$/.test(raw)) state.kpiConfirmed=true;
      else if(/分析|試算|教えて|[?？]/.test(raw)) { question=raw; state.pending=null; }
      else return clarify('試算前提の入力欄を確認してください。未入力は保存済み値、未登録なら仮置きになります。',['入力した前提で進む','保存済み前提・仮置きで進む','キャンセル']);
      period=state.period;
    } else if(state.pending?.kind==='period' && !period && /分析|試算|教えて|[?？]/.test(raw)) {
      question=raw;
    }
    if(period) state.period=period;
    if(state.pending?.kind==='period' && period && /分析|試算|教えて|[?？]|どう/.test(question)) {
      state.methods=null;
      state.kpiConfirmed=false;
    }
    if(!state.period || (state.pending?.kind==='period' && !period)) {
      state.pending={kind:'period',question};
      return clarify('どの期間を分析しますか？ 例「2026年6月」「2026年6月と7月を比較」「2026-06-01〜2026-06-15」。おまかせなら保存済み全期間です。',['保存済み全期間','今月','先月',...(options.viewingDate?['表示中の日']:[]),'キャンセル']);
    }
    if(isRestartQuestion(raw) && options.hasPriorAnswer) {
      state.methods=null;
      state.kpiConfirmed=false;
      state.assumptionsConfirmed=false;
      state.allowEstimate=false;
    }
    const skipMethods = Boolean(options.hasPriorAnswer && state.methods?.length && !isRestartQuestion(raw) && !isRestartQuestion(question));
    if(!skipMethods && !state.methods) {
      state.pending={kind:'methods',question,recommended:recommendAnalysisMethods(question, options.historyText),selected:[],showAll:false};
      return methodsClarify(state);
    }
    if(options.hasAssumptions && !inputChoiceResolved && !wantsKpiTargets(question, options.historyText) && needsInputTrialChoice(question) && !state.methods) {
      state.pending={kind:'kpi_use',question};
      return clarify('入力した売価・原価などの前提を分析に使います。保守・標準・強気の3シナリオでKPIの数値試算も行いますか？',trialChoices);
    }
    if(wantsKpiTargets(question, options.historyText) && !state.kpiConfirmed && !options.assumptionsReady && !state.methods) {
      state.pending={kind:'kpi',question};
      return clarify('KPI試算の前提を確認します。売価・原価・焼成個数/回数・人員・廃棄許容率は分かりますか？ 下の「試算前提」に入力するか、保存済み値・仮置きで進められます。',['入力した前提で進む','保存済み前提・仮置きで進む','キャンセル']);
    }
    if(wantsKpiTargets(question, options.historyText)) {
      state.methods=normalizeMethodIds([...(state.methods||[]),'kpi']);
      state.kpiConfirmed=true;
    }
    if(needsPriceCostInputs(question, options.historyText, state.methods) && !state.assumptionsConfirmed) {
      if(hasPriceAndCost(options)) {
        state.assumptionsConfirmed=true;
        state.allowEstimate=false;
      } else {
        state.pending={kind:'assumptions',question};
        return assumptionsClarify(state, options);
      }
    }
    state.pending=null;
    return {state,kind:'ready',question,period:state.period,methods:state.methods||[],allowEstimate:state.allowEstimate===true};
  }
  function promptMethods(state, question, options={}) {
    const next = {...state, methods:null};
    next.pending={kind:'methods',question,recommended:recommendAnalysisMethods(question, options.historyText),selected:[],showAll:false};
    return methodsClarify(next);
  }
  root.FOODCOURT_QA_PLANNER={resolvePeriod,wantsKpiTargets,recommendAnalysisMethods,needsPriceCostInputs,parsePriceCostFromText,ANALYSIS_METHODS,initialState,nextTurn,promptMethods};
})(globalThis);
