import {JSDOM} from 'jsdom';
import {fileURLToPath} from 'node:url';
import {readFileSync} from 'node:fs';
import vm from 'node:vm';
import {webcrypto} from 'node:crypto';
export const ROOT=fileURLToPath(new URL('../../',import.meta.url));
const W=process.env.CHAT_SAFETY_CANDIDATE_ROOT || ROOT;
export const OWNER='11111111-1111-4111-8111-111111111111';
export const CAP={contract_version:1,own_clear_supported:true,mark_read_supported:true,snapshot_semantics:'statement_visible_ids'};
export const state=(ids,revision='0',suppressed=false)=>ids.map(id=>({contract_version:1,user_id:OWNER,group_id:String(id),revision,timeline_suppressed:suppressed}));
export const receipt=b=>({contract_version:1,kind:'clear',user_id:OWNER,group_id:b.p_group_id,request_id:b.p_request_id,applied_revision:String(BigInt(b.p_expected_revision)+1n),status:'applied'});
export const tick=()=>new Promise(r=>setImmediate(r));
export function deferred(){let resolve;const promise=new Promise(r=>resolve=r);return {resolve,promise};}
export function exactPrivateNoteInsert(ops,content,groupId=10){
 return JSON.stringify(ops)===JSON.stringify([['insert',{group_id:groupId,user_id:OWNER,content}],['select','id, group_id, content, created_at'],['single']]);
}
export async function fixture({candidateRoot=W}={}){
 const W=candidateRoot;
 const html=readFileSync(W+'/public/chat.html','utf8');
 const dom=new JSDOM(html,{url:'https://independent.synthetic.invalid/chat.html',runScripts:'outside-only',pretendToBeVisual:true});
 const w=dom.window, calls=[],denied=[],listeners=[],alerts=[],diagnostics=[];
 let rpc=async()=>undefined,query=async()=>undefined;
 const deny=(kind,args)=>{denied.push({kind,args});throw Error('INDEPENDENT_FORBIDDEN '+kind);};
 w.fetch=(...a)=>deny('fetch',a); w.XMLHttpRequest=class{constructor(){deny('XMLHttpRequest',[]);}}; w.WebSocket=class{constructor(...a){deny('WebSocket',a);}};
 w.EventSource=class{constructor(...a){deny('EventSource',a);}};w.navigator.sendBeacon=(...a)=>deny('beacon',a);
 w.matchMedia=()=>({matches:false,addEventListener(){},removeEventListener(){}});w.ResizeObserver=class{observe(){}disconnect(){}};
 w.HTMLCanvasElement.prototype.getContext=()=>({measureText:()=>({width:8})});
 w.requestAnimationFrame=()=>0;w.setInterval=()=>0;
 w.alert=x=>alerts.push(String(x));w.confirm=()=>true;
 w.console={...console,error:(...x)=>diagnostics.push(x.map(String).join(' '))};
 Object.defineProperty(w,'crypto',{value:webcrypto});
 const session={user:{id:OWNER},access_token:'independent-synthetic-session'};
 const sb={auth:{getSession:async()=>({data:{session:null}}),onAuthStateChange:fn=>{listeners.push(fn);return {data:{subscription:{unsubscribe(){}}}};},signOut:async()=>{listeners.forEach(fn=>fn('SIGNED_OUT',null));return {error:null};}},
  rpc:async(name,body)=>{calls.push({rpc:name,body});const result=await rpc(name,body);return result===undefined?deny('rpc',{name,body}):result;},
  from:table=>{const ops=[];const chain=new Proxy({},{get:(_,k)=>k==='then'?(yes,no)=>Promise.resolve().then(async()=>{calls.push({table,ops});const result=await query(table,ops);return result===undefined?deny('table',{table,ops}):result;}).then(yes,no):(...a)=>{ops.push([k,...a]);return chain;}});return chain;}
 };
 w.supabase={createClient:()=>sb};
 const run=s=>vm.runInContext(s,dom.getInternalVMContext());
 const scripts=[...html.matchAll(/<script\b[^>]*src="([^"]+)"[^>]*>/g)].map(x=>x[1].split('?')[0]).filter(x=>x.startsWith('chat/'));
 for(const path of scripts)run(readFileSync(W+'/public/'+path,'utf8'));
 await tick();
 run(`currentUser={id:'${OWNER}',username:'独立検証'};currentChatAccess={access_enabled:true,signup_status:'approved'};myGroups=[{id:10,group_name:'合成ルームA',created_at:'2026-01-01T00:00:00Z',membership:{can_view:true,can_send:true},own_history_revision:'0',own_history_suppressed:false}];talkTab='all';`);
 listeners.forEach(fn=>fn('SIGNED_IN',session));
 return {w,run,calls,denied,alerts,diagnostics,listeners,session,scripts,rpc:fn=>rpc=fn,query:fn=>query=fn,
 async close(){await tick();await tick();dom.window.close();if(denied.length)throw Error('Forbidden attempts at teardown: '+JSON.stringify(denied));}};
}
export function groupsQuery(allowed=true,{legacy=false}={}){return async(table,ops)=>{
 if(ops.some(o=>['insert','update','delete','upsert'].includes(o[0])))return undefined;
 if(table==='chat_group_members'&&ops.some(o=>o[0]==='eq'&&o[1]==='user_id'))return {data:allowed?[{can_view:true,can_send:true,...(legacy?{}:{own_history_revision:'0',own_history_suppressed:false}),chat_groups:{id:10,group_name:'合成ルームA',created_at:'2026-01-01T00:00:00Z'}}]:[]};
 if(['chat_groups','chat_group_members','chat_messages'].includes(table))return {data:[]};
 return undefined;
};}
export async function standardRpc(name,body){if(name==='chat_own_history_states_v1')return {data:state(body.p_group_ids)};if(name==='chat_unread_counts')return {data:[]};return undefined;}
