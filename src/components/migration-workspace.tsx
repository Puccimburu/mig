import { createContext, useContext, useRef, useState, type ChangeEvent, type ReactNode } from 'react';
import { Link } from '@tanstack/react-router';
import { ArrowDownToLine, ArrowLeftRight, ArrowRight, Bell, Check, CheckCheck, ChevronDown, ChevronLeft, ChevronRight, CircleCheck, CircleHelp, Clock3, FileCheck2, FileClock, FilePlus2, FileText, FolderOpen, History, Layers3, ListFilter, LoaderCircle, Menu, MoreHorizontal, Plus, RefreshCw, Search, Settings2, ShieldCheck, Sparkles, Ticket, Trash2, TriangleAlert, Upload, X, type LucideIcon } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { TransformationWizard } from '@/components/transformation/TransformationWizard';
import { ActivityProvider, formatWhen, useActivity, useNow, type ActivityEvent } from '@/components/activity';

type Document = { id: number; name: string; size: string; type: string; request: string; status: string; date: string };
const initialDocuments: Document[] = [
  { id: 1, name: 'Master_Service_Agreement.pdf', size: '2.4 MB', type: 'Main', request: 'REQ-2026-00124', status: 'Completed', date: '07 Oct 2026, 09:42' },
  { id: 2, name: 'Statement_of_Work_2026.pdf', size: '1.8 MB', type: 'Supporting', request: 'REQ-2026-00124', status: 'Completed', date: '07 Oct 2026, 09:40' },
  { id: 3, name: 'Vendor_Agreement_Acme.pdf', size: '3.1 MB', type: 'Main', request: 'REQ-2026-00125', status: 'Processing', date: '07 Oct 2026, 09:38' },
  { id: 4, name: 'Compliance_Certificate.pdf', size: '856 KB', type: 'Supporting', request: 'REQ-2026-00125', status: 'Partially completed', date: '07 Oct 2026, 09:35' },
  { id: 5, name: 'Service_Agreement_Northstar.pdf', size: '4.2 MB', type: 'Main', request: 'REQ-2026-00126', status: 'Failed', date: '07 Oct 2026, 09:30' },
  { id: 6, name: 'Insurance_Document.pdf', size: '1.2 MB', type: 'Supporting', request: '—', status: 'Pending', date: '07 Oct 2026, 09:28' },
];
const sections: { id: string; title: string; subtitle?: string; icon: LucideIcon; label?: string }[] = [
  { id: 'cleaning', title: 'Sanity Checks', subtitle: 'Cleaning data', icon: Sparkles },
  { id: 'transformation', title: 'Transformation', icon: ArrowLeftRight },
  { id: 'uploads', title: 'Uploads', subtitle: 'Main & supporting documents', icon: Upload },
  { id: 'request-id', title: 'Populate Request ID', icon: FileCheck2 },
  { id: 'processing', title: 'Processing', subtitle: 'Failed & partially completed', icon: LoaderCircle, label: '2' },
  { id: 'amendments', title: 'Amendments & lifecycle', subtitle: 'Amendments, renewals & terminations', icon: FilePlus2 },
  { id: 'audit', title: 'Audit trail', icon: History },
  { id: 'sanity-checks', title: 'Sanity Checks', subtitle: 'Post-migration validation', icon: ShieldCheck },
  { id: 'tickets', title: 'Ticketing', icon: Ticket },
];
export function sectionTitle(id: string) { return sections.find(s => s.id === id)?.title ?? 'Uploads'; }
export function workspaceHead(title: string) { const full = `${title} · Auto-Migrate`; const description = `Manage ${title.toLowerCase()} in the Auto-Migrate document migration workspace.`; return { meta: [{ title: full }, { name: 'description', content: description }, { property: 'og:title', content: full }, { property: 'og:description', content: description }, { property: 'og:type', content: 'website' }, { name: 'twitter:card', content: 'summary_large_image' }] }; }
function tone(status: string) { return status === 'Completed' || status === 'Passed' ? 'success' : status === 'Processing' ? 'info' : status === 'Failed' ? 'danger' : status === 'Partially completed' ? 'warning' : 'neutral'; }
function Status({ value }: { value: string }) { return <span className={`badge tone-${tone(value)}`}><i />{value}</span>; }

function useWorkspaceState() {
  const [documents, setDocuments] = useState(initialDocuments);
  const [tickets, setTickets] = useState([{ id: 'TKT-001', subject: 'Missing signature in Northstar agreement', priority: 'High', status: 'Open', details: '' }, { id: 'TKT-002', subject: 'Review compliance certificate fields', priority: 'Medium', status: 'Open', details: '' }]);
  return { documents, setDocuments, tickets, setTickets };
}
const WorkspaceContext = createContext<ReturnType<typeof useWorkspaceState> | null>(null);
export function WorkspaceProvider({ children }: { children: ReactNode }) {
  const state = useWorkspaceState();
  return <ActivityProvider><WorkspaceContext.Provider value={state}>{children}</WorkspaceContext.Provider></ActivityProvider>;
}
export function MigrationWorkspace({ section }: { section: string }) {
  const shared = useContext(WorkspaceContext);
  if (!shared) return null;
  return <WorkspaceView section={section} shared={shared}/>;
}

function WorkspaceView({ section, shared }: { section: string; shared: ReturnType<typeof useWorkspaceState> }) {
  const { documents, setDocuments, tickets, setTickets } = shared;
  const { events, log, snapshot } = useActivity();
  const now = useNow();
  const [tab, setTab] = useState('All documents');
  const [query, setQuery] = useState('');
  const [status, setStatus] = useState('All statuses');
  const [selected, setSelected] = useState<number[]>([]);
  const [mobileOpen, setMobileOpen] = useState(false);
  const [notice, setNotice] = useState('');
  const [detail, setDetail] = useState<Document | null>(null);
  const [ticketOpen, setTicketOpen] = useState(false);
  const [ticketSubject, setTicketSubject] = useState('');
  const [ticketNotes, setTicketNotes] = useState('');
  const [dragging, setDragging] = useState('');
  const mainInput = useRef<HTMLInputElement>(null);
  const supportingInput = useRef<HTMLInputElement>(null);
  const current = sections.find(s => s.id === section) ?? sections[2];
  const title = section === 'amendments' ? 'Amendments, renewals & terminations' : sectionTitle(section);
  const subtitles: Record<string,string> = { uploads: 'Upload and manage your main and supporting documents in one place.', cleaning: 'Review data quality and resolve issues before migration.', transformation: 'Prepare and standardize document data for migration.', 'request-id': 'Assign request IDs and connect supporting documents.', processing: 'Review and retry failed or partially completed documents.', amendments: 'Manage document changes across the contract lifecycle.', audit: 'A complete record of document activity and migration events.', 'sanity-checks': 'Validate document integrity after migration.', tickets: 'Track exceptions and resolve migration issues.' };
  function uploadFiles(files: FileList | File[] | null, type: string) {
    if (!files) return;
    const valid = Array.from(files).filter(f => /\.(pdf|docx?|xlsx?|csv)$/i.test(f.name) && f.size <= 25 * 1024 * 1024);
    if (!valid.length) { setNotice('Please choose a PDF, DOCX, XLSX or CSV file under 25 MB.'); return; }
    const rows = valid.map((f,i) => ({ id: Date.now()+i, name: f.name, size: f.size < 1024 * 1024 ? `${Math.max(1,Math.round(f.size / 1024))} KB` : `${(f.size / 1024 / 1024).toFixed(1)} MB`, type, request: '—', status: 'Pending', date: 'Just now' }));
    setDocuments(d => [...rows,...d]); log({ title: `${valid.length} ${type.toLowerCase()} document${valid.length > 1 ? 's' : ''} uploaded`, detail: valid.map(f => f.name).join(', '), tone: 'success' });
    setNotice(`${valid.length} document${valid.length > 1 ? 's' : ''} added to this demo session${valid.length !== Array.from(files).length ? '; unsupported or oversized files were skipped' : ''}.`);
  }
  function onFileChange(e: ChangeEvent<HTMLInputElement>, type: string) { uploadFiles(e.target.files,type); e.target.value = ''; }
  function runAction() {
    const targets = selected.length ? selected : documents.filter(d => section !== 'processing' || ['Failed','Partially completed'].includes(d.status)).map(d => d.id);
    setDocuments(d => d.map(row => targets.includes(row.id) ? { ...row, request: section === 'request-id' && row.request === '—' ? `REQ-2026-${String(127 + row.id).padStart(5,'0')}` : row.request, status: section === 'request-id' ? row.status : 'Completed' } : row));
    const action = section === 'request-id' ? 'Request IDs assigned' : section === 'cleaning' || section === 'sanity-checks' ? 'Validation completed' : section === 'transformation' ? 'Transformation completed' : 'Demo processing completed';
    setNotice(`${action} for ${targets.length} documents in this session.`); log({ title: action, detail: `${targets.length} document${targets.length === 1 ? '' : 's'} · ${current?.title ?? section}`, tone: 'success' }); setSelected([]);
  }
  function exportRows() {
    const text = ['Document,Type,Request ID,Status,Uploaded at', ...documents.map(d => [d.name,d.type,d.request,d.status,d.date].map(v => `"${v.replaceAll('"','""')}"`).join(','))].join('\n');
    const url = URL.createObjectURL(new Blob([text], { type: 'text/csv' })); const a = window.document.createElement('a'); a.href = url; a.download = 'auto-migrate-uploads.csv'; a.click(); URL.revokeObjectURL(url); setNotice('Document report exported.');
  }
  const filtered = documents.filter(d => (section !== 'processing' || ['Failed','Partially completed'].includes(d.status)) && (tab === 'All documents' || d.type === (tab === 'Main documents' ? 'Main' : tab === 'Supporting documents' ? 'Supporting' : tab)) && (status === 'All statuses' || d.status === status) && `${d.name} ${d.request}`.toLowerCase().includes(query.toLowerCase()));
  const isUpload = section === 'uploads' || section === 'amendments';
  // Figures from the latest transformation run (per document = row of the working sheet).
  const pct = (n: number) => snapshot && snapshot.total ? ` · ${Math.round(n / snapshot.total * 100)}%` : '';
  const stats: { label: string; value: number | null; icon: LucideIcon; tone: string; foot: string; title?: string | undefined }[] = [
    { label: 'Total documents', value: snapshot?.total ?? null, icon: FileText, tone: 'neutral', foot: snapshot ? `${snapshot.sheet} · ${formatWhen(snapshot.at, now)}` : 'Run a transformation to see figures', title: snapshot ? `${snapshot.clientFile} — ${snapshot.sheet}` : undefined },
    { label: 'Completed', value: snapshot?.completed ?? null, icon: CircleCheck, tone: 'success', foot: `Filled into templates without issues${snapshot ? pct(snapshot.completed) : ''}` },
    { label: 'Pending', value: snapshot?.pending ?? null, icon: Clock3, tone: 'info', foot: 'Amendments, renewals, supporting docs & skipped templates' },
    { label: 'Needs attention', value: snapshot?.needsAttention ?? null, icon: TriangleAlert, tone: 'warning', foot: 'Rows with dropdown, mandatory or file path issues' },
  ];
  const tabs = section === 'amendments' ? ['All documents','Amendment','Renewal','Termination'] : ['All documents','Main documents','Supporting documents'];
  return <div className="workspace">
    <aside className={`sidebar ${mobileOpen ? 'open' : ''}`}>
      <Link to="/" className="brand"><span className="brand-mark"><Layers3 strokeWidth={2.3}/></span>Auto-Migrate</Link>
      <div className="workspace-select"><FolderOpen/><div><strong>Migration workspace</strong><small>Document operations</small></div><ChevronDown size={13} className="ml-auto text-muted-foreground"/></div>
      <div className="nav-label">MIGRATION WORKFLOW</div>
      <nav className="navigation" aria-label="Migration workflow">{sections.slice(0,6).map(s=><Button key={s.id} asChild variant={s.id===section?'activeNavigation':'navigation'} className="nav-item"><Link to={s.id==='uploads'?'/':'/workflow/$section'} params={s.id==='uploads'?{}:{section:s.id}} onClick={()=>setMobileOpen(false)}><s.icon/><span>{s.title}{s.subtitle&&<small>{s.subtitle}</small>}</span>{s.label&&<span className="nav-count">{documents.filter(d=>['Failed','Partially completed'].includes(d.status)).length}</span>}</Link></Button>)}</nav>
      <div className="nav-divider"/><div className="nav-label">MONITOR & MANAGE</div>
      <nav className="navigation" aria-label="Monitor and manage">{sections.slice(6).map(s=><Button key={s.id} asChild variant={s.id===section?'activeNavigation':'navigation'} className="nav-item"><Link to="/workflow/$section" params={{section:s.id}} onClick={()=>setMobileOpen(false)}><s.icon/><span>{s.title}{s.subtitle&&<small>{s.subtitle}</small>}</span></Link></Button>)}</nav>
      <div className="sidebar-bottom"><div className="demo-indicator"><span className="status-dot"/>Demo workspace<span className="ml-auto">v1.0</span></div><div className="profile"><span className="avatar">AM</span><div><strong>Migration team</strong><small>Workspace operator</small></div><Settings2 size={15} className="ml-auto text-muted-foreground"/></div></div>
    </aside>
    <div className="main-shell"><header className="topbar"><div className="breadcrumb"><Button variant="ghost" size="icon" className="mobile-menu" aria-label={mobileOpen?'Close menu':'Open menu'} onClick={()=>setMobileOpen(!mobileOpen)}>{mobileOpen?<X/>:<Menu/>}</Button><span>Workspace</span><ChevronRight/><span>{current?.title}</span></div><div className="top-actions"><span className="environment"><span className="status-dot"/>Demo environment</span><Button variant="ghost" size="icon" title="Notifications" aria-label="Notifications" className="notification" onClick={()=>setNotice('2 documents need attention: a failed agreement and a partially completed certificate.')}><Bell/></Button><Button variant="ghost" size="icon" title="Workspace information" aria-label="Workspace information" onClick={()=>setNotice('Demo workspace: documents and changes remain in this session. No live migration service is connected.')}><CircleHelp/></Button><span className="avatar">AM</span></div></header>
    <main className="content"><div className="page-heading"><div><div className="eyebrow">DOCUMENT MIGRATION</div><h1>{title}</h1><p>{subtitles[section]??subtitles['uploads']}</p></div>{section!=='transformation'&&<div className="heading-actions"><Button variant="outline" onClick={exportRows}><ArrowDownToLine/>Export report</Button><Button onClick={()=>section==='tickets'?setTicketOpen(true):isUpload?mainInput.current?.click():section==='audit'?setNotice('Activity log is up to date.'):runAction()}>{isUpload?<Plus/>:section==='tickets'?<Plus/>:<RefreshCw/>}{isUpload?'Upload documents':section==='tickets'?'Create ticket':section==='request-id'?'Populate IDs':section==='processing'?'Retry processing':section==='transformation'?'Transform data':section==='audit'?'Refresh activity':'Run checks'}</Button></div>}</div>
    {notice&&<div className="notice" role="status"><span>{notice}</span><Button variant="ghost" size="icon" className="h-5 w-5" aria-label="Dismiss message" onClick={()=>setNotice('')}><X/></Button></div>}
    <div className="stats">{stats.map(s=><div className="stat" key={s.label} title={s.title}><div className="stat-top"><span>{s.label}</span><span className={`stat-icon tone-${s.tone}`}><s.icon/></span></div><div className="stat-value">{s.value===null?'—':s.value.toLocaleString()}</div><div className="stat-bottom">{s.tone==='success'&&s.value!==null?<CheckCheck className="text-success"/>:null}{s.foot}</div></div>)}</div>
    <input ref={mainInput} type="file" multiple accept=".pdf,.doc,.docx,.xls,.xlsx,.csv" hidden aria-label="Upload main documents" onChange={e=>onFileChange(e,section==='amendments'?'Amendment':'Main')}/><input ref={supportingInput} type="file" multiple accept=".pdf,.doc,.docx,.xls,.xlsx,.csv" hidden aria-label="Upload supporting documents" onChange={e=>onFileChange(e,section==='amendments'?'Renewal':'Supporting')}/>
    {isUpload&&<section className="upload-section"><div className="section-heading"><h2>Upload documents</h2><span>Secure uploads · Up to 25 MB per file</span></div><div className="upload-grid">{[{label:section==='amendments'?'Amendment documents':'Main documents',type:section==='amendments'?'Amendment':'Main',ref:mainInput,icon:Upload},{label:section==='amendments'?'Renewal & termination documents':'Supporting documents',type:section==='amendments'?'Renewal':'Supporting',ref:supportingInput,icon:FilePlus2}].map(z=><div key={z.type} className={`upload-zone ${dragging===z.type?'dragging':''}`} onDragOver={e=>{e.preventDefault();setDragging(z.type);}} onDragLeave={()=>setDragging('')} onDrop={e=>{e.preventDefault();setDragging('');uploadFiles(e.dataTransfer.files,z.type);}}><div className="upload-icon"><z.icon/></div><h3>{z.label}</h3><p>Drag and drop your files here, or <Button variant="link" className="browse" onClick={()=>z.ref.current?.click()}>browse files</Button></p><small>PDF, DOCX, XLSX, CSV · Max 25 MB</small></div>)}</div></section>}
    {section==='cleaning'&&<Checklist section={section} onEscalate={m=>setNotice(m)}/>}
    {section==='transformation'?<TransformationWizard/>:section==='tickets'?<section className="table-section"><div className="section-heading"><h2>Migration tickets <span className="count-pill">{tickets.length}</span></h2></div><div className="table-overflow"><table className="document-table"><thead><tr><th>Ticket</th><th>Subject</th><th>Priority</th><th>Status</th><th>Action</th></tr></thead><tbody>{tickets.map(t=><tr key={t.id}><td>{t.id}</td><td>{t.subject}</td><td>{t.priority}</td><td><Status value={t.status}/></td><td><Button variant="ghost" size="sm" disabled={t.status==='Completed'} onClick={()=>{setTickets(a=>a.map(x=>x.id===t.id?{...x,status:'Completed'}:x));setNotice(`${t.id} resolved.`);log({title:`Ticket ${t.id} resolved`,detail:t.subject,tone:'success'});}}>Resolve</Button></td></tr>)}</tbody></table></div></section>:section==='audit'?<section className="table-section"><div className="section-heading"><h2>Activity log <span className="count-pill">{events.length}</span></h2><span>Actions taken in this browser</span></div><div className="table-overflow"><table className="document-table activity-table"><thead><tr><th/><th>Event</th><th>Details</th><th>Time</th></tr></thead><tbody>{events.map(e=><tr key={e.id}><td><span className={`activity-dot tone-${e.tone}`}/></td><td><strong>{e.title}</strong></td><td className="activity-detail">{e.detail}</td><td className="table-date" title={new Date(e.at).toLocaleString()}>{formatWhen(e.at, now)}</td></tr>)}{!events.length&&<tr><td colSpan={4} className="text-center text-muted-foreground h-24">No activity yet. Uploads, transformations, processing and tickets are recorded here as they happen.</td></tr>}</tbody></table></div></section>:<section className="table-section"><div className="table-title-row"><h2>{section==='processing'?'Documents requiring attention':section==='cleaning'||section==='sanity-checks'?'Document validation':section==='transformation'?'Transformation queue':section==='request-id'?'Request ID assignments':'Recent uploads'}<span className="count-pill">{filtered.length}</span></h2><Button variant="ghost" size="sm" onClick={()=>{setQuery('');setStatus('All statuses');setTab('All documents');setNotice('Showing all documents in this session.');}}><RefreshCw/>Refresh</Button></div><div className="table-tools"><div className="tabs" role="tablist" aria-label="Document type">{tabs.map(t=><Button variant="ghost" role="tab" aria-selected={t===tab} key={t} className={`tab ${t===tab?'active':''}`} onClick={()=>{setTab(t);setSelected([]);}}>{t}</Button>)}</div><div className="filters"><div className="search-box"><Search/><input placeholder="Search documents..." aria-label="Search documents" value={query} onChange={e=>setQuery(e.target.value)}/></div><select aria-label="Filter status" value={status} onChange={e=>setStatus(e.target.value)}>{['All statuses','Completed','Processing','Pending','Partially completed','Failed'].map(s=><option key={s}>{s}</option>)}</select></div></div>
    {selected.length>0&&<div className="flex items-center gap-3 py-3 text-xs"><span>{selected.length} selected</span><Button variant="secondary" size="sm" onClick={runAction}>{section==='request-id'?'Populate IDs':'Process selected'}</Button><Button variant="ghost" size="sm" onClick={()=>{log({title:`${selected.length} document${selected.length===1?'':'s'} removed`,detail:documents.filter(r=>selected.includes(r.id)).map(r=>r.name).join(', '),tone:'danger'});setDocuments(d=>d.filter(r=>!selected.includes(r.id)));setSelected([]);setNotice('Selected documents removed from this session.');}}><Trash2/>Remove</Button></div>}
    <div className="table-overflow"><table className="document-table"><thead><tr><th><input type="checkbox" aria-label="Select all documents" checked={filtered.length>0&&filtered.every(d=>selected.includes(d.id))} onChange={e=>setSelected(e.target.checked?filtered.map(d=>d.id):[])}/></th><th>Document name</th><th>Type</th><th>Request ID</th><th>Status</th><th>Uploaded at</th><th/></tr></thead><tbody>{filtered.map(d=><tr key={d.id}><td><input type="checkbox" aria-label={`Select ${d.name}`} checked={selected.includes(d.id)} onChange={e=>setSelected(s=>e.target.checked?[...s,d.id]:s.filter(id=>id!==d.id))}/></td><td><div className="file-cell"><span className="file-symbol"><FileText/><small>{d.name.split('.').pop()?.toUpperCase()}</small></span><div><strong>{d.name}</strong><span className="file-size">{d.size}</span></div></div></td><td><span className={`doc-type ${d.type==='Main'?'main':''}`}>{d.type}</span></td><td className="request-id">{d.request}</td><td><Status value={d.status}/></td><td className="table-date">{d.date}</td><td><Button variant="ghost" size="icon" className="row-action" aria-label={`Details for ${d.name}`} onClick={()=>setDetail(d)}><MoreHorizontal/></Button></td></tr>)}{!filtered.length&&<tr><td colSpan={7} className="text-center text-muted-foreground h-24">No documents found.</td></tr>}</tbody></table></div><div className="table-footer"><span>Showing {filtered.length?1:0}–{filtered.length} of {filtered.length} documents</span><div className="pagination"><Button variant="outline" size="icon" disabled aria-label="Previous page"><ChevronLeft/></Button><Button variant="secondary" size="icon" aria-label="Page 1">1</Button><Button variant="outline" size="icon" disabled aria-label="Next page"><ChevronRight/></Button></div></div></section>}
    <section className="activity-section"><div className="section-heading"><h2>Recent activity</h2><Button asChild variant="link"><Link to="/workflow/$section" params={{section:'audit'}}>View audit trail<ArrowRight/></Link></Button></div>{events.length ? <div className="activity-list">{events.slice(0,4).map(e=><ActivityItem key={e.id} event={e} now={now}/>)}</div> : <p className="activity-empty">No activity yet. Actions you take in the workspace, such as running a transformation, appear here.</p>}</section>
    <footer className="page-footer"><span>© 2026 Auto-Migrate. All rights reserved.</span><span><ShieldCheck size={11}/>Demo workspace · Session-only data</span></footer></main></div>
    <Dialog open={Boolean(detail)} onOpenChange={open=>{if(!open)setDetail(null);}}><DialogContent><DialogHeader><DialogTitle className="break-all">{detail?.name}</DialogTitle><DialogDescription>Document details</DialogDescription></DialogHeader>{detail&&<><div className="modal-summary"><div><span>Document type</span><select aria-label="Change document type" value={detail.type} onChange={e=>{const updated={...detail,type:e.target.value};setDetail(updated);setDocuments(a=>a.map(d=>d.id===detail.id?updated:d));}}>{['Main','Supporting','Amendment','Renewal','Termination'].map(t=><option key={t}>{t}</option>)}</select></div><div><span>Size</span>{detail.size}</div><div><span>Request ID</span>{detail.request}</div><div><span>Status</span><Status value={detail.status}/></div><div><span>Uploaded</span>{detail.date}</div></div>{detail.status==='Failed'&&<p className="text-sm text-destructive">Demo exception: a required signature is missing.</p>}{detail.status==='Partially completed'&&<p className="text-sm text-warning">Demo exception: some compliance fields need review.</p>}<div className="flex justify-end gap-2 mt-3"><Button variant="outline" onClick={()=>{setTicketSubject(`Review ${detail.name}`);setDetail(null);setTicketOpen(true);}}><Ticket/>Create ticket</Button><Button onClick={()=>{setSelected([detail.id]);setDetail(null);setNotice('Document selected. Use Process selected to complete demo processing.');}}>Select document</Button></div></>}</DialogContent></Dialog>
    <Dialog open={ticketOpen} onOpenChange={setTicketOpen}><DialogContent><DialogHeader><DialogTitle>Create ticket</DialogTitle><DialogDescription>Record a migration issue in this demo session.</DialogDescription></DialogHeader><form className="modal-fields" onSubmit={e=>{e.preventDefault();setTickets(a=>[...a,{id:`TKT-${String(a.length+1).padStart(3,'0')}`,subject:ticketSubject,priority:'Medium',status:'Open',details:ticketNotes}]);log({title:`Ticket TKT-${String(tickets.length+1).padStart(3,'0')} created`,detail:ticketSubject,tone:'warning'});setNotice('Ticket created in this session.');setTicketSubject('');setTicketNotes('');setTicketOpen(false);}}><label>Subject<input required value={ticketSubject} onChange={e=>setTicketSubject(e.target.value)} placeholder="Briefly describe the issue"/></label><label>Details<textarea value={ticketNotes} onChange={e=>setTicketNotes(e.target.value)} placeholder="Add document references and issue details"/></label><Button type="submit"><Plus/>Create ticket</Button></form></DialogContent></Dialog>
  </div>;
}

const checklists: Record<string,{title:string;detail:string;escalate?:string}[]> = {
  cleaning: [
    { title: 'Deduplicate client data', detail: 'Remove duplicate client records before migration.' },
    { title: 'Check duplicate file names', detail: 'Confirm every file name is unique.' },
    { title: 'Confirm party names are configured', detail: 'Download the bulk import template with all party names and VLOOKUP against client data.', escalate: 'Send unconfigured party names to the project functional contact.' },
    { title: 'Confirm assignees / users are configured', detail: 'Every assignee provided by the client must exist on the system.' },
    { title: 'Verify parent–child linkage', detail: 'Link main agreements to supporting documents, amendments, renewals and terminations.' },
    { title: 'Check mandatory fields', detail: 'Party name, Party type, Address line 1, Country, Assignee, Legal party must have data.' },
    { title: 'Validate drop-down values', detail: 'Client values must match the bulk import template drop-downs.', escalate: 'Escalate out-of-range values to the project manager.' },
  ],
  transformation: [
    { title: 'Map field names', detail: 'All client field names must exist on the bulk template.', escalate: 'Inform the PM about fields that do not match.' },
    { title: 'Confirm file paths', detail: 'Every client record needs a file path.', escalate: 'Inform the PM about missing file paths.' },
  ],
};
function Checklist({ section, onEscalate }: { section: string; onEscalate: (m: string) => void }) {
  const items = checklists[section] ?? [];
  const [done, setDone] = useState<number[]>([]);
  return <section className="checklist"><div className="section-heading"><h2>{section==='cleaning'?'Step 1 · Sanity checks checklist':'Step 2 · Transformation checklist'}</h2><span>{done.length} of {items.length} complete</span></div>
    <ol>{items.map((it,i)=><li key={it.title} className={done.includes(i)?'done':''}><label><input type="checkbox" checked={done.includes(i)} onChange={()=>setDone(d=>d.includes(i)?d.filter(x=>x!==i):[...d,i])}/><span><strong>{it.title}</strong><small>{it.detail}</small></span></label>{it.escalate&&<Button variant="outline" size="sm" onClick={()=>onEscalate(it.escalate!)}>Escalate</Button>}</li>)}</ol></section>;
}

const TONE_ICON: Record<ActivityEvent['tone'], LucideIcon> = { success: Check, info: RefreshCw, warning: TriangleAlert, danger: X };
function ActivityItem({ event, now }: { event: ActivityEvent; now: number }) {
  const Icon = TONE_ICON[event.tone];
  return <div className="activity-item"><span className={`activity-icon tone-${event.tone}`}><Icon/></span><div><strong>{event.title}</strong><p title={event.detail}>{event.detail}</p><small title={new Date(event.at).toLocaleString()}>{formatWhen(event.at, now)}</small></div></div>;
}
