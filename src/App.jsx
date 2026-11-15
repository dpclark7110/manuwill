import React,{useEffect,useState} from 'react';
import{createClient}from '@supabase/supabase-js';
const url=import.meta.env.VITE_SUPABASE_URL, key=import.meta.env.VITE_SUPABASE_ANON_KEY||import.meta.env.VITE_SUPABASE_PUBLISHABLE_KEY;
const db=url&&key?createClient(url,key):null;
function ChamberChat({councilId,members}){
  const [messages,setMessages]=useState([]);
  const [draft,setDraft]=useState('');
  const [error,setError]=useState('');
  const [sending,setSending]=useState(false);
  useEffect(()=>{
    let active=true;
    let request=0;
    async function refresh(){
      const version=++request;
      const result=await db.from('council_messages').select('id,author_id,body,created_at')
        .eq('council_id',councilId).order('id',{ascending:false}).limit(100);
      if(!active||version!==request)return;
      if(result.error)setError(result.error.message);
      else setMessages(result.data.reverse());
    }
    refresh();
    const channel=db.channel('chamber-'+councilId)
      .on('postgres_changes',{event:'INSERT',schema:'public',table:'council_messages',filter:'council_id=eq.'+councilId},refresh)
      .subscribe(status=>{if(status==='SUBSCRIBED')refresh()});
    const timer=window.setInterval(refresh,15000);
    return ()=>{active=false;window.clearInterval(timer);db.removeChannel(channel)};
  },[councilId]);
  async function send(event){
    event.preventDefault();
    if(sending||!draft.trim())return;
    setSending(true);
    setError('');
    try{
      const result=await db.from('council_messages').insert({council_id:councilId,body:draft.trim()})
        .select('id,author_id,body,created_at').single();
      if(result.error)throw result.error;
      setMessages(previous=>previous.some(message=>message.id===result.data.id)
        ?previous:[...previous,result.data].sort((first,second)=>first.id-second.id).slice(-100));
      setDraft('');
    }catch(error){setError(error.message)}
    finally{setSending(false)}
  }
  return <section aria-label="Council Chamber chat">
    <h3>Chamber chat</h3>
    {error&&<p className="error" role="alert">{error}</p>}
    <div role="log" aria-label="Recent messages">
      {messages.map(message=><article key={message.id} className="member">
        <div><b>{members.find(member=>member.user_id===message.author_id)?.display_name||'Council member'}</b>
        <small>{new Date(message.created_at).toLocaleString()}</small>
        <p style={{whiteSpace:'pre-wrap',overflowWrap:'anywhere'}}>{message.body}</p></div>
      </article>)}
    </div>
    <form onSubmit={send}>
      <textarea aria-label="Message" placeholder="Write a message" value={draft}
        disabled={sending} maxLength={2000} onChange={event=>setDraft(event.target.value)}/>
      <button disabled={sending||!draft.trim()}>Send message</button>
    </form>
  </section>;
}
function CitationNotebook({councilId,onFile}){
  const [notes,setNotes]=useState([]);
  const [body,setBody]=useState('');
  const [editing,setEditing]=useState(null);
  const [error,setError]=useState('');
  const [busy,setBusy]=useState(true);
  useEffect(()=>{
    let mounted=true;
    db.from('citation_drafts').select('id,body').eq('council_id',councilId)
      .order('created_at',{ascending:false}).then(({data,error})=>{
        if(!mounted)return;
        if(error)setError(error.message);
        else setNotes(data);
        setBusy(false);
      });
    return ()=>{mounted=false};
  },[councilId]);
  async function save(event){
    event.preventDefault();
    if(busy||!body.trim())return;
    setBusy(true);
    setError('');
    const write=editing
      ?db.from('citation_drafts').update({body:body.trim()}).eq('id',editing)
      :db.from('citation_drafts').insert({council_id:councilId,body:body.trim()});
    const {data,error}=await write.select('id,body').single();
    if(error)setError(error.message);
    else{
      setNotes(previous=>editing?previous.map(note=>note.id===editing?data:note):[data,...previous]);
      setEditing(null);
      setBody('');
    }
    setBusy(false);
  }
  async function remove(id){
    if(busy)return;
    setBusy(true);
    setError('');
    const {error}=await db.from('citation_drafts').delete().eq('id',id).select('id').single();
    if(error)setError(error.message);
    else{
      setNotes(previous=>previous.filter(note=>note.id!==id));
      if(editing===id){setEditing(null);setBody('')}
    }
    setBusy(false);
  }
  return <section aria-label="Personal Citation Notebook">
    <h3>Draft notes</h3>
    {error&&<p className="error" role="alert">{error}</p>}
    <form onSubmit={save}>
      <textarea aria-label="Citation draft" value={body} maxLength={4000}
        onChange={event=>setBody(event.target.value)} disabled={busy} required/>
      <button disabled={busy||!body.trim()}>{editing?'Save changes':'Save draft'}</button>
      {editing&&<button type="button" className="ghost" disabled={busy}
        onClick={()=>{setEditing(null);setBody('')}}>Cancel edit</button>}
    </form>
    {notes.map(note=><article key={note.id}>
      <p style={{whiteSpace:'pre-wrap',overflowWrap:'anywhere'}}>{note.body}</p>
      <button className="ghost" disabled={busy} onClick={()=>{setEditing(note.id);setBody(note.body)}}>Edit</button>
      <button className="ghost" disabled={busy} onClick={()=>{setEditing(null);setBody(note.body)}}>Duplicate</button>
      <button className="ghost" disabled={busy} onClick={()=>onFile(note)}>Use in citation</button>
      <button className="ghost" disabled={busy} onClick={()=>remove(note.id)}>Delete</button>
    </article>)}
  </section>;
}
const verdictLabels={
  guilty:'Guilty',not_guilty:'Not guilty',bogus_claim:'Bogus claim',dismissed:'Dismissed'
};
function CouncilGameplay({councilId,members,userId,tab,draft,onDraftFiled}){
  const [game,setGame]=useState(null);
  const [error,setError]=useState('');
  const [version,setVersion]=useState(0);
  const [notice,setNotice]=useState('');
  const [busy,setBusy]=useState(false);
  useEffect(()=>{
    let cancelled=false;
    async function load(){
      const [terms,citations,scores]=await Promise.all([
        db.from('council_terms').select('id,starts_at,ends_at,finalized_at')
          .eq('council_id',councilId).order('starts_at',{ascending:false}).limit(1),
        db.from('council_citations').select('id,accuser_id,accused_id,incident,proposed_points,created_at,voting_closes_at,verdict,resolution_reason')
          .eq('council_id',councilId).order('created_at',{ascending:false}).limit(50),
        db.from('council_term_points').select('term_id,user_id,points')
          .eq('council_id',councilId)
      ]);
      if(cancelled)return;
      const failure=terms.error||citations.error||scores.error;
      if(failure){setError(failure.message);return}
      setGame({term:terms.data[0],citations:citations.data,scores:scores.data});
    }
    load();
    return ()=>{cancelled=true};
  },[councilId,version,tab]);
  async function submit(event,rpc,values,success){
    event.preventDefault();
    if(busy)return;
    const form=event.currentTarget;
    setBusy(true);
    setError('');
    setNotice('');
    try{
      const {error}=await db.rpc(rpc,values(new FormData(form)));
      if(error)throw error;
      form.reset();
      if(rpc==='file_citation_from_draft')onDraftFiled();
      setNotice(success);
      setVersion(current=>current+1);
    }catch(error){setError(error.message)}
    finally{setBusy(false)}
  }
  const term=game?.term;
  const now=Date.now();
  const member=members.find(person=>person.user_id===userId);
  const memberName=id=>members.find(person=>person.user_id===id)?.display_name||'Council member';
  const standings=members.map(person=>({
    ...person,points:game?.scores.find(score=>score.term_id===term?.id&&score.user_id===person.user_id)?.points??100
  })).sort((first,second)=>second.points-first.points);
  const filingOpen=term&&!term.finalized_at&&Date.parse(term.starts_at)<=now&&now<Date.parse(term.ends_at)&&members.length>=4;
  return <section>
    {error&&<p className="error" role="alert">{error}</p>}
    {notice&&<p className="success" role="status">{notice}</p>}
    {!game&&!error&&<p role="status">Loading Council gameplay…</p>}
    {game&&tab==='overview'&&<>
      <h3>Council standings</h3>
      {term?<><p>Term ends {new Date(term.ends_at).toLocaleString()}</p>
        <ol>{standings.map(person=><li key={person.user_id}>
          {memberName(person.user_id)} · {person.points} points {person.points===0?'· Revoked':''}
        </li>)}</ol></>:<p>This Council has no Term yet.</p>}
    </>}
    {game&&tab==='citations'&&<>
      <h3>Citations</h3>
      {filingOpen?<form onSubmit={event=>submit(event,draft?'file_citation_from_draft':'file_council_citation',form=>({
        ...(draft?{p_draft_id:draft.id}:{}),
        p_council_id:councilId,p_accused_id:form.get('accused'),p_incident:form.get('incident').trim(),
        p_proposed_points:Number(form.get('points'))
      }),'Citation filed.')}>
        <label>Member<select name="accused" required defaultValue="">
          <option value="" disabled>Choose a member</option>
          {members.filter(person=>person.user_id!==userId).map(person=>
            <option key={person.user_id} value={person.user_id}>{memberName(person.user_id)}</option>)}
        </select></label>
        <label>Incident<textarea name="incident" key={draft?.id} defaultValue={draft?.body} required maxLength={4000}/></label>
        <label>Proposed deduction<select name="points">
          {[5,10,15,20,25].map(points=><option key={points} value={points}>{points} points</option>)}
        </select></label>
        <button disabled={busy}>File citation</button>
      </form>:<p>Filing requires an active Term and at least two eligible voters besides the accuser and accused.</p>}
      {!game.citations.length&&<p>No citations filed.</p>}
      {game.citations.map(citation=>{
        const canVote=member&&!citation.verdict&&now<Date.parse(citation.voting_closes_at)&&
          ![citation.accuser_id,citation.accused_id].includes(userId)&&
          Date.parse(member.joined_at)<=Date.parse(citation.created_at);
        return <article className="panel" key={citation.id}>
          <h4>{memberName(citation.accused_id)} · {citation.proposed_points} points proposed</h4>
          <p style={{whiteSpace:'pre-wrap',overflowWrap:'anywhere'}}>{citation.incident}</p>
          <p>{citation.verdict?verdictLabels[citation.verdict]:now>=Date.parse(citation.voting_closes_at)
            ?'Voting closed. Verdict pending.':'Voting closes '+new Date(citation.voting_closes_at).toLocaleString()}</p>
          {citation.resolution_reason&&<p>{citation.resolution_reason}</p>}
          {canVote&&<form onSubmit={event=>submit(event,'vote_on_citation',form=>({
            p_citation_id:citation.id,p_verdict:form.get('verdict')
          }),'Private vote saved. You can change it before voting closes.')}>
            <label>Private verdict<select name="verdict" defaultValue="" required><option value="" disabled>Choose a verdict</option>
              {Object.entries(verdictLabels).filter(([value])=>value!=='dismissed').map(([value,label])=>
                <option key={value} value={value}>{label}</option>)}
            </select></label>
            <button disabled={busy}>Save vote</button>
          </form>}
        </article>;
      })}
    </>}
  </section>;
}
export default function App(){
const [filingDraft,setFilingDraft]=useState(null);
const[session,S]=useState(null),[loading,L]=useState(true),[error,E]=useState(''),[notice,N]=useState(''),[mode,M]=useState('login'),[email,Em]=useState(''),[password,P]=useState(''),[name,D]=useState(''),[councils,C]=useState([]),[active,A]=useState(null),[members,B]=useState([]),[tab,T]=useState('overview'),[councilName,CN]=useState(''),[description,Desc]=useState(''),[code,Code]=useState(()=>new URLSearchParams(window.location.search).get('invite')?.trim().toUpperCase().match(/^[A-Z0-9]{6}$/)?.[0]||''),[invite,I]=useState(''),[profile,Profile]=useState(null);
useEffect(()=>{if(!db){L(false);return}db.auth.getSession().then(({data})=>{S(data.session);L(false)});const{data:{subscription}}=db.auth.onAuthStateChange((_,s)=>S(s));return()=>subscription.unsubscribe()},[]);
useEffect(()=>{if(session)refresh();else{C([]);A(null)}},[session?.user?.id]);
useEffect(()=>{
  let cancelled=false;
  B([]);
  if(active)db.rpc('council_roster',{p_council_id:active.id}).then(({data,error})=>{
    if(cancelled)return;
    if(error)E(error.message);
    else B(data??[]);
  });
  return ()=>{cancelled=true};
},[active?.id,session?.user?.id]);
async function run(fn){E('');N('');try{await fn()}catch(e){E(e.message||String(e))}}
async function refresh(){const uid=session?.user?.id;if(!uid)return;const[{data:joins,error:je},{data:p}]=await Promise.all([db.from('council_members').select('council_id').eq('user_id',uid),db.from('profiles').select('*').eq('id',uid).maybeSingle()]);if(je){E(je.message);return}Profile(p);const ids=(joins||[]).map(x=>x.council_id);if(!ids.length){C([]);A(null);return}const{data,error}=await db.from('councils').select('*').in('id',ids);if(error){E(error.message);return}C(data||[]);A(old=>(data||[]).find(x=>x.id===old?.id)||(data||[])[0]||null)}
async function auth(e){e.preventDefault();await run(async()=>{if(!db)throw Error('Supabase environment variables are not configured.');if(mode==='reset'){const{error}=await db.auth.resetPasswordForEmail(email);if(error)throw error;N('Password reset email sent.');return}if(mode==='signup'){const{error}=await db.auth.signUp({email,password,options:{data:{display_name:name}}});if(error)throw error;N('Account created. Check your email if confirmation is required.');return}const{error}=await db.auth.signInWithPassword({email,password});if(error)throw error})}
async function createCouncil(e){e.preventDefault();await run(async()=>{const{error}=await db.rpc('create_council',{p_name:councilName.trim(),p_description:description.trim()});if(error)throw error;CN('');Desc('');N('Council created.');await refresh()})}
async function redeem(e){e.preventDefault();await run(async()=>{const{error}=await db.rpc('redeem_council_invitation',{p_code:code.trim().toUpperCase()});if(error)throw error;const url=new URL(window.location.href);url.searchParams.delete('invite');window.history.replaceState(null,'',url);Code('');N('Invitation redeemed.');await refresh()})}
async function createInvite(){await run(async()=>{const{data,error}=await db.rpc('create_council_invitation',{p_council_id:active.id});if(error)throw error;const value=typeof data==='string'?data:data?.code||JSON.stringify(data);I(value);N('Invitation created. Share the code or link privately.')})}
async function updateProfile(e){e.preventDefault();await run(async()=>{const{error}=await db.from('profiles').update({display_name:name.trim()}).eq('id',session.user.id);if(error)throw error;N('Profile updated.');await refresh()})}
const title=<div className="brand">Man<span>U</span>will</div>;
if(loading)return <main className="center">{title}<p>Opening the Chamber…</p></main>;
if(!db)return <main className="center">{title}<section className="panel"><h2>Setup required</h2><p>Configure VITE_SUPABASE_URL and VITE_SUPABASE_ANON_KEY in Netlify, then redeploy.</p></section></main>;
if(!session)return <main className="center"><div className="crest">TM</div>{title}<p className="tagline">Every Man Has a Card.<br/>Not Every Man Keeps It.</p><form className="panel auth" onSubmit={auth}><h2>{mode==='signup'?'Join the Brotherhood':mode==='reset'?'Reset password':'Enter the Chamber'}</h2>{mode==='signup'&&<input required placeholder="Display name" value={name} onChange={e=>D(e.target.value)}/>}<input type="email" required placeholder="Email" value={email} onChange={e=>Em(e.target.value)}/>{mode!=='reset'&&<input type="password" minLength="6" required placeholder="Password" value={password} onChange={e=>P(e.target.value)}/>}<button>{mode==='signup'?'Create account':mode==='reset'?'Send reset link':'Sign in'}</button><div className="links"><button type="button" className="link" onClick={()=>M(mode==='signup'?'login':'signup')}>{mode==='signup'?'Already a member? Sign in':'Create account'}</button><button type="button" className="link" onClick={()=>M(mode==='reset'?'login':'reset')}>{mode==='reset'?'Back to login':'Forgot password?'}</button></div></form>{error&&<p className="error">{error}</p>}{notice&&<p className="success">{notice}</p>}</main>;
return <div className="app"><header><div className="brand small">Man<span>U</span>will</div><button className="ghost" onClick={()=>db.auth.signOut()}>Sign out</button></header><div className="content"><p className="eyebrow">THE BROTHERHOOD</p><h1>Welcome to the Chamber</h1><p className="muted">{profile?.display_name||session.user.email}</p>{error&&<p className="error">{error}</p>}{notice&&<p className="success">{notice}</p>}<div className="stats"><div><strong>{councils.length}</strong><small>My Councils</small></div><div><strong>{active?members.length:'—'}</strong><small>Members</small></div></div><section className="panel"><h2>My Councils</h2>{councils.length?<div className="pills">{councils.map(c=><button key={c.id} className={active?.id===c.id?'selected':'ghost'} onClick={()=>{A(c);T('overview');I('');setFilingDraft(null)}}>{c.name}</button>)}</div>:<p className="muted">No Councils yet. Create one or join with an invitation.</p>}</section>{active&&<section className="panel"><p className="eyebrow">COUNCIL CHAMBER</p><h2>{active.name}</h2><p className="muted">{active.description||'Private Council'}</p><div className="tabs">{['overview','members','invitations','chat','notebook','citations'].map(x=><button key={x} className={tab===x?'selected':'ghost'} onClick={()=>T(x)}>{x}</button>)}</div>{(tab==='overview'||tab==='citations')&&<CouncilGameplay key={active.id} councilId={active.id} members={members} userId={session.user.id} tab={tab} draft={filingDraft?.councilId===active.id&&filingDraft.userId===session.user.id?filingDraft.note:null} onDraftFiled={()=>setFilingDraft(null)}/>}{tab==='members'&&<div>{members.map(m=><div className="member" key={m.user_id}><div className="avatar">{(m.display_name||'?')[0].toUpperCase()}</div><div><b>{m.display_name||'Council member'}</b><small>{m.user_id===active.chairman_id?'Chairman':'Member'}</small></div></div>)}</div>}{tab==='notebook'&&<CitationNotebook key={active.id} councilId={active.id} onFile={note=>{setFilingDraft({councilId:active.id,userId:session.user.id,note});T('citations')}}/>} {tab==='chat'&&<ChamberChat key={active.id} councilId={active.id} members={members}/>} {tab==='invitations'&&<>{active.chairman_id===session.user.id?<><p className="muted">Invitations expire after 7 days.</p><button onClick={createInvite}>Generate invitation code</button>{invite&&<div className="invite"><div>{invite}</div><input aria-label="Shareable invitation link" readOnly value={new URL(`?invite=${encodeURIComponent(invite)}`,window.location.origin).href} onFocus={e=>e.target.select()}/></div>}</>:<p>Only the Chairman can generate invitations.</p>}</>}</section>}<div className="columns"><section className="panel"><h2>Start a Council</h2><form onSubmit={createCouncil}><input required maxLength="60" placeholder="Council name" value={councilName} onChange={e=>CN(e.target.value)}/><textarea placeholder="Description (optional)" value={description} onChange={e=>Desc(e.target.value)}/><button>Create Council</button></form></section><section className="panel"><h2>Join a Council</h2><form onSubmit={redeem}><input required maxLength="6" placeholder="6-character invite code" value={code} onChange={e=>Code(e.target.value.toUpperCase())}/><button>Redeem Invitation</button></form></section></div><section className="panel"><h2>My Profile</h2><form onSubmit={updateProfile}><input placeholder="Display name" value={name} onChange={e=>D(e.target.value)}/><button className="secondary">Save display name</button></form></section><footer>ManUwill · Private beta · Built with Purpose</footer></div></div>
}