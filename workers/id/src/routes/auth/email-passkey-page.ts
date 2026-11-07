export type EmailPageMode = "signup" | "verify" | "register" | "recover";

/** Fully self-contained IdP page. No token or authority is interpolated. */
export function emailPasskeyPage(mode: EmailPageMode, csrf: string, nonce: string) {
  if ((csrf && !/^[A-Za-z0-9_-]{43}$/.test(csrf)) || !/^[A-Za-z0-9_-]{22}$/.test(nonce))
    throw new Error("Invalid page context");
  const title = {
    signup: "メールで新規登録",
    verify: "メールアドレスの確認",
    register: "パスキーを登録",
    recover: "パスキーで確認してください",
  }[mode];
  const form =
    mode === "signup"
      ? `<form id="action"><label for="email">メールアドレス</label><input id="email" type="email" maxlength="254" required autocomplete="email"><button id="continue" type="submit">確認メールを依頼する</button></form><p>このブラウザーで確認リンクを開いてください。既存のアカウントには追加・統合しません。</p>`
      : mode === "verify"
        ? `<p>ボタンを押すとメールアドレスを確認し、新規登録を続けます。</p><button id="continue" type="button" ${csrf ? "" : "disabled"}>メールアドレスを確認して続ける</button><p><a href="/auth/email/register">確認済みの場合は登録画面へ</a></p>`
        : mode === "register"
          ? `<form id="action" action="/auth/email/registration/complete" method="post"><label for="name">表示名</label><input id="name" maxlength="100" required autocomplete="nickname"><input type="hidden" name="csrf" value="${csrf}"><input type="hidden" name="credential" id="credential"><button id="continue" type="submit">パスキーを作成する</button></form><p>登録後、作成したパスキーでもう一度本人確認してからログインします。</p>`
          : `<p>登録結果を確認できない場合も、メールの再送や再登録は自動で行いません。パスキーでの本人確認を試してください。</p><form action="/auth/email/login" method="post"><input type="hidden" name="csrf" value="${csrf}"><input type="hidden" name="confirm" value="true"><button type="submit" ${csrf ? "" : "disabled"}>パスキーでログインを試す</button></form>`;
  return `<!doctype html><html lang="ja"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="referrer" content="no-referrer"><title>0g0 ID · ${title}</title>
<style nonce="${nonce}">body{margin:0;background:#f5f7fa;color:#172333;font:1rem/1.7 system-ui,sans-serif;display:grid;min-height:100svh;place-items:center}main{box-sizing:border-box;width:min(100% - 2rem,30rem);padding:2rem;background:white;border:1px solid #dce3eb;border-radius:1rem}h1{font-size:1.5rem}input,button{box-sizing:border-box;width:100%;padding:.7rem;margin:.4rem 0 1rem;font:inherit;border:1px solid #8c9bac;border-radius:.4rem}button{cursor:pointer;background:#174a7e;color:white}button:disabled{opacity:.6;cursor:wait}a{color:#174a7e}#status{min-height:3rem}a:focus-visible,input:focus-visible,button:focus-visible{outline:3px solid #d77c14;outline-offset:3px}</style>
</head><body><main><small>0g0 ID</small><h1>${title}</h1>${form}<p>登録開始から10分以内に、このブラウザーで確認とパスキー登録を完了してください。メールの到着が遅い場合も期限は延長されません。</p><p id="status" role="status" aria-live="polite"></p><noscript>JavaScript が必要です。</noscript>
<script nonce="${nonce}">
// First operations: capture only the bounded fragment and remove it synchronously.
const mode='${mode}';
let token='';
if(mode==='verify'){
  const fragment=location.hash.length<=256?location.hash.slice(1):'';
  history.replaceState(null,'','/auth/email/verify');
  const values=new URLSearchParams(fragment);
  if(values.size===1&&values.getAll('token').length===1&&/^[A-Za-z0-9_-]{43}$/.test(values.get('token')||''))token=values.get('token');
}
const csrf='${csrf}';
const button=document.getElementById('continue');
const status=document.getElementById('status');
const form=document.getElementById('action');
let active=null;
if(mode==='verify'&&(!csrf||!token)){
  button.disabled=true; status.textContent=!csrf?'登録を始めた元のブラウザーでリンクを開いてください。':'確認リンクを開き直すか、確認済みの場合は登録画面へ進んでください。';
}
const decode=(s)=>Uint8Array.from(atob(s.replace(/-/g,'+').replace(/_/g,'/')),x=>x.charCodeAt(0));
const encode=(b)=>btoa(String.fromCharCode(...new Uint8Array(b))).replace(/\\+/g,'-').replace(/\\//g,'_').replace(/=/g,'');
async function post(path,body,signal){
 const response=await fetch(path,{method:'POST',credentials:'same-origin',cache:'no-store',headers:{'Content-Type':'application/json'},signal,body:JSON.stringify(body)});
 if(!response.ok)throw new Error('unavailable'); return response.json();
}
async function act(event){
 if(event)event.preventDefault(); if(active)return;
 const controller=new AbortController();active=controller;button.disabled=true;status.textContent='確認しています。';
 try{
  if(mode==='signup'){
   await post('/auth/email/start',{csrf,confirm:true,email:document.getElementById('email').value},controller.signal);
   if(controller.signal.aborted)return;
   status.textContent='手続きを受け付けました。案内が届いた場合は、このブラウザーでリンクを開いてください。';
  }else if(mode==='verify'){
   await post('/auth/email/verify',{csrf,confirm:true,token},controller.signal);
   if(controller.signal.aborted)return;token='';location.assign('/auth/email/register');
  }else if(mode==='register'){
   if(!window.PublicKeyCredential||!navigator.credentials)throw new Error('unsupported');
   const data=await post('/auth/email/registration/options',{csrf,confirm:true,name:document.getElementById('name').value},controller.signal);
   if(controller.signal.aborted)return;
   const options={...data.options,challenge:decode(data.options.challenge),user:{...data.options.user,id:decode(data.options.user.id)},excludeCredentials:(data.options.excludeCredentials||[]).map(x=>({...x,id:decode(x.id)}))};
   const key=await navigator.credentials.create({publicKey:options,signal:controller.signal});
   if(controller.signal.aborted)return;if(!key)throw new Error('unavailable');
   const proof={id:key.id,rawId:encode(key.rawId),type:key.type,clientExtensionResults:key.getClientExtensionResults(),response:{clientDataJSON:encode(key.response.clientDataJSON),attestationObject:encode(key.response.attestationObject),transports:key.response.getTransports?key.response.getTransports():[]}};
   document.getElementById('credential').value=JSON.stringify(proof);status.textContent='登録結果を確認しています。';form.submit();
  }
 }catch(error){
  status.textContent=error.name==='NotAllowedError'||error.name==='AbortError'?'操作をキャンセルしました。もう一度選べます。':'手続きを確認できませんでした。通信が戻ったら再確認してください。メールは自動再送しません。';
  if(!controller.signal.aborted){active=null;button.disabled=false;}
 }
}
if(form)form.addEventListener('submit',act);else if(button)button.addEventListener('click',act);
window.addEventListener('pagehide',()=>{if(active)active.abort();});
window.addEventListener('pageshow',(event)=>{if(event.persisted)location.reload();});
</script></main></body></html>`;
}
