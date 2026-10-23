import { useEffect, useMemo, useState } from 'react';
import { Alert, Field, Outputs, PdfPicker, RunStatus, Spinner, outName, useRunner, usePdfDoc, type PdfSource } from '../../components/common';
import { PageNav, PageStage, type Pt } from '../../components/PageStage';
import { encryptPdf, ALL_ALLOWED, type Permissions } from '../qpdf';
import { redactPdf, findTextRects, type RedactRect } from '../raster';
import { inspectSignatures } from '../ops/structure';
import { readMetadata, writeMetadata, stripMetadata, type MetaFields } from '../ops/pdf';
import { reportUsage } from '../../lib/api';

export function Encrypt({ id }: { id: string }) {
  const [src, setSrc] = useState<PdfSource | null>(null);
  const [pw, setPw] = useState(''), [pw2, setPw2] = useState(''), [owner, setOwner] = useState('');
  const [perms, setPerms] = useState<Permissions>({ ...ALL_ALLOWED });
  const r = useRunner(id);
  const labels: [keyof Permissions, string][] = [['print', '允許列印'], ['copy', '允許複製文字/圖片'], ['modify', '允許編輯內容'], ['annotate', '允許加註解'], ['fill', '允許填寫表單'], ['assemble', '允許組合頁面（插入/刪除/旋轉）'], ['accessibility', '允許輔助工具讀取']];
  const strength = pw.length >= 14 ? '強' : pw.length >= 10 ? '中' : pw ? '弱' : '';
  return (
    <div className="space-y-4">
      <PdfPicker value={src} onChange={(s) => { setSrc(s); r.setOutputs([]); }} />
      {src && (
        <div className="card space-y-4">
          <div className="grid gap-3 sm:grid-cols-2">
            <Field label="開啟密碼（必填）" hint={strength ? `強度：${strength}（建議 ≥ 12 字元）` : undefined}><input type="password" autoComplete="new-password" className="input" value={pw} onChange={(e) => setPw(e.target.value)} /></Field>
            <Field label="再次輸入"><input type="password" autoComplete="new-password" className="input" value={pw2} onChange={(e) => setPw2(e.target.value)} /></Field>
            <Field label="擁有者密碼（選填）" hint="用於變更權限；留空會自動產生一組隨機且不會顯示的密碼"><input type="password" autoComplete="new-password" className="input" value={owner} onChange={(e) => setOwner(e.target.value)} /></Field>
          </div>
          <div className="grid gap-2 sm:grid-cols-2">
            {labels.map(([k, l]) => <label key={k} className="flex items-center gap-2 text-sm"><input type="checkbox" checked={perms[k]} onChange={(e) => setPerms({ ...perms, [k]: e.target.checked })} />{l}</label>)}
          </div>
          {pw && pw2 && pw !== pw2 && <Alert kind="error">兩次輸入的密碼不一致</Alert>}
          <Alert kind="warn">加密使用 AES-256。<b>忘記密碼將無法復原檔案。</b>權限限制（列印/複製）依賴閱讀器遵守，部分軟體可能忽略。</Alert>
          <button className="btn btn-primary" disabled={r.busy || !pw || pw !== pw2} onClick={() => r.run(async () => [{ name: outName(src.name, '_encrypted'), data: await encryptPdf(src.bytes, { userPassword: pw, ownerPassword: owner || undefined, perms }) }], { bytes: src.originalSize })}>
            {r.busy ? <Spinner /> : '🔐'} 加密</button>
        </div>
      )}
      <RunStatus r={r} /><Outputs items={r.outputs} beforeSize={src?.originalSize} />
    </div>
  );
}

export function Decrypt({ id }: { id: string }) {
  const [src, setSrc] = useState<PdfSource | null>(null);
  const r = useRunner(id);
  return (
    <div className="space-y-4">
      <PdfPicker value={src} onChange={(s) => { setSrc(s); r.setOutputs([]); }} label="選擇已加密的 PDF（輸入密碼後即可解除）" />
      {src && (
        <div className="card space-y-3">
          {src.wasEncrypted ? <Alert kind="ok">已成功以密碼解鎖。下載的檔案將不含加密與權限限制。</Alert> : <Alert kind="info">此檔案本來就沒有加密。</Alert>}
          <button className="btn btn-primary" disabled={r.busy} onClick={() => r.run(async () => [{ name: outName(src.name, '_decrypted'), data: src.bytes }], { bytes: src.originalSize })}>🔓 取得未加密版本</button>
        </div>
      )}
      <RunStatus r={r} /><Outputs items={r.outputs} />
    </div>
  );
}

const PRESETS: { k: string; l: string; re: RegExp }[] = [
  { k: 'email', l: 'Email', re: /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/ },
  { k: 'phone', l: '電話 / 手機', re: /(?:\+?886[-\s]?)?0?9\d{2}[-\s]?\d{3}[-\s]?\d{3}|\b0\d{1,2}[-\s]?\d{6,8}\b/ },
  { k: 'twid', l: '台灣身分證字號', re: /[A-Z][12]\d{8}/ },
  { k: 'card', l: '信用卡號', re: /\b(?:\d[ -]?){13,16}\b/ },
  { k: 'date', l: '日期', re: /\d{4}[-/.年]\d{1,2}[-/.月]\d{1,2}日?/ },
];
const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

export function Redact({ id }: { id: string }) {
  const [src, setSrc] = useState<PdfSource | null>(null);
  const { doc } = usePdfDoc(src?.bytes ?? null);
  const [page, setPage] = useState(0);
  const [rects, setRects] = useState<Record<number, (RedactRect & { id: string })[]>>({});
  const [drag, setDrag] = useState<Pt | null>(null);
  const [cur, setCur] = useState<RedactRect | null>(null);
  const [kw, setKw] = useState('');
  const [presets, setPresets] = useState<string[]>([]);
  const [dpi, setDpi] = useState(200);
  const [finding, setFinding] = useState(false);
  const [msg, setMsg] = useState('');
  const r = useRunner(id);
  const total = Object.values(rects).reduce((s, l) => s + l.length, 0);
  const norm = (a: Pt, b: Pt): RedactRect => ({ x: Math.min(a.x, b.x), y: Math.min(a.y, b.y), w: Math.abs(a.x - b.x), h: Math.abs(a.y - b.y) });
  const add = (pg: number, rs: RedactRect[]) => setRects((m) => ({ ...m, [pg]: [...(m[pg] ?? []), ...rs.map((x) => ({ ...x, id: crypto.randomUUID() }))] }));
  const find = async () => {
    if (!doc) return;
    setFinding(true); setMsg('');
    try {
      const pats: RegExp[] = PRESETS.filter((p) => presets.includes(p.k)).map((p) => p.re);
      for (const k of kw.split(/[,，\n]/).map((s) => s.trim()).filter(Boolean)) pats.push(new RegExp(esc(k), 'gi'));
      if (!pats.length) { setMsg('請選擇類型或輸入關鍵字'); return; }
      const found = await findTextRects(doc, pats);
      const n = Object.values(found).reduce((sum, l) => sum + l.length, 0);
      setRects((m) => {
        const next = { ...m };
        for (const [pg, rs] of Object.entries(found)) next[+pg] = [...(next[+pg] ?? []), ...rs.map((x) => ({ ...x, id: crypto.randomUUID() }))];
        return next;
      });
      setMsg(n ? `找到 ${n} 處，已加入塗黑清單（請在頁面上確認位置）` : '沒有找到符合的文字（掃描檔請先 OCR）');
    } finally { setFinding(false); }
  };
  return (
    <div className="space-y-4">
      <PdfPicker value={src} onChange={(s) => { setSrc(s); setRects({}); r.setOutputs([]); setPage(0); }} />
      {src && doc && (
        <>
          <div className="card space-y-3">
            <div className="text-sm font-semibold">自動尋找敏感資訊</div>
            <div className="flex flex-wrap gap-2">
              {PRESETS.map((p) => <label key={p.k} className={`btn btn-sm cursor-pointer ${presets.includes(p.k) ? 'btn-primary' : ''}`}><input type="checkbox" hidden checked={presets.includes(p.k)} onChange={() => setPresets((a) => (a.includes(p.k) ? a.filter((x) => x !== p.k) : [...a, p.k]))} />{p.l}</label>)}
            </div>
            <div className="flex gap-2"><input className="input" placeholder="自訂關鍵字（逗號分隔）" value={kw} onChange={(e) => setKw(e.target.value)} />
              <button className="btn" disabled={finding} onClick={() => void find()}>{finding ? <Spinner /> : '🔍'} 尋找</button></div>
            {msg && <div className="hint">{msg}</div>}
          </div>
          <div className="flex flex-wrap items-center gap-3">
            <PageNav page={page} total={src.pages} onChange={setPage} />
            <span className="chip">共 {total} 個塗黑區域</span>
            <button className="btn btn-sm" disabled={!rects[page]?.length} onClick={() => setRects((m) => ({ ...m, [page]: [] }))}>清除本頁</button>
          </div>
          <div className="overflow-auto rounded-lg bg-slate-200 p-3 dark:bg-slate-800" style={{ maxHeight: '70vh' }}>
            <PageStage pdf={doc} pageIndex={page} scale={1} lockTouch cursor="crosshair"
              onDown={(p) => { setDrag(p); setCur({ x: p.x, y: p.y, w: 0, h: 0 }); }}
              onMove={(p) => drag && setCur(norm(drag, p))}
              onUp={(p) => { if (drag) { const n = norm(drag, p); if (n.w > 4 && n.h > 4) add(page, [n]); } setDrag(null); setCur(null); }}>
              {({ scale }) => (
                <>
                  {(rects[page] ?? []).map((x) => (
                    <div key={x.id} className="absolute bg-black/80 ring-1 ring-red-500" style={{ left: x.x * scale, top: x.y * scale, width: x.w * scale, height: x.h * scale }}
                      onDoubleClick={() => setRects((m) => ({ ...m, [page]: m[page].filter((y) => y.id !== x.id) }))} title="雙擊移除" />
                  ))}
                  {cur && <div className="absolute border border-red-500 bg-red-500/30" style={{ left: cur.x * scale, top: cur.y * scale, width: cur.w * scale, height: cur.h * scale }} />}
                </>
              )}
            </PageStage>
          </div>
          <div className="card space-y-3">
            <Field label={`輸出解析度 ${dpi} DPI`} hint="含塗黑的頁面會被轉成圖片；DPI 越高越清晰、檔案越大"><input type="range" min={100} max={300} step={20} value={dpi} onChange={(e) => setDpi(+e.target.value)} className="w-full" /></Field>
            <Alert kind="warn">
              <b>真正塗黑：</b>含塗黑區域的頁面會被重新點陣化並取代，底層文字與影像不會留在檔案中。這些頁面的文字將不可選取（可再做 OCR）。輸出檔會全新重建，不含原文件的中繼資料與書籤。
            </Alert>
            <button className="btn btn-danger" disabled={r.busy || total === 0} onClick={() => r.run(async (rep) => {
              const plain: Record<number, RedactRect[]> = {};
              for (const [k, v] of Object.entries(rects)) plain[+k] = v.map(({ id: _i, ...x }) => x);
              return [{ name: outName(src.name, '_redacted'), data: await redactPdf(src.bytes, plain, { dpi, quality: 0.9 }, rep) }];
            }, { bytes: src.originalSize })}>{r.busy ? <Spinner /> : '⬛'} 執行塗黑並輸出</button>
          </div>
        </>
      )}
      <RunStatus r={r} /><Outputs items={r.outputs} beforeSize={src?.originalSize} />
    </div>
  );
}

export function Signatures({ id }: { id: string }) {
  const [src, setSrc] = useState<PdfSource | null>(null);
  const sigs = useMemo(() => (src ? inspectSignatures(src.bytes) : []), [src]);
  useEffect(() => { if (src) reportUsage(id, src.originalSize); }, [src, id]);
  const fmt = (m?: string) => {
    const x = m?.match(/D:(\d{4})(\d\d)(\d\d)(\d\d)?(\d\d)?(\d\d)?/);
    return x ? `${x[1]}-${x[2]}-${x[3]} ${x[4] ?? '00'}:${x[5] ?? '00'}:${x[6] ?? '00'}` : m ?? '—';
  };
  return (
    <div className="space-y-4">
      <PdfPicker value={src} onChange={setSrc} />
      {src && (sigs.length === 0 ? <Alert kind="info">此文件沒有數位簽章。</Alert> : (
        <div className="space-y-3">
          {sigs.map((s) => (
            <div key={s.index} className="card space-y-2">
              <div className="flex flex-wrap items-center gap-2">
                <span className="font-semibold">簽章 #{s.index + 1}</span>
                {s.coversWholeFile ? <span className="chip !bg-emerald-100 !text-emerald-800">簽署後未追加內容</span> : <span className="chip !bg-amber-100 !text-amber-800">簽署後檔案有追加內容（可能是後續簽章或修改）</span>}
              </div>
              <table className="tbl"><tbody>
                {([['簽署者（欄位宣告）', s.name], ['簽署時間（欄位宣告）', fmt(s.signingTime)], ['原因', s.reason], ['地點', s.location], ['聯絡資訊', s.contactInfo], ['格式 (SubFilter)', s.subFilter], ['涵蓋範圍 (ByteRange)', s.byteRange.join(', ')], ['內嵌憑證數量（估計）', String(s.certCount)]] as const).map(([k, v]) => (
                  <tr key={k}><td className="w-52 text-slate-500">{k}</td><td>{v || '—'}</td></tr>))}
              </tbody></table>
            </div>
          ))}
          <Alert kind="warn"><b>重要：</b>本工具僅檢視簽章結構，<b>不驗證密碼學簽章與憑證鏈</b>，因此不能據此判定簽章「有效」。請使用 Adobe Acrobat 或政府/CA 提供的驗證服務確認法律效力。</Alert>
        </div>
      ))}
    </div>
  );
}

export function Metadata({ id }: { id: string }) {
  const [src, setSrc] = useState<PdfSource | null>(null);
  const [meta, setMeta] = useState<MetaFields>({});
  const [dates, setDates] = useState<{ created?: Date; modified?: Date }>({});
  const r = useRunner(id);
  useEffect(() => {
    setMeta({}); if (!src) return;
    readMetadata(src.bytes).then(({ created, modified, ...m }) => { setMeta(m); setDates({ created, modified }); });
  }, [src]);
  const keys: [keyof MetaFields, string][] = [['title', '標題'], ['author', '作者'], ['subject', '主旨'], ['keywords', '關鍵字'], ['creator', '建立程式'], ['producer', '轉換程式']];
  return (
    <div className="space-y-4">
      <PdfPicker value={src} onChange={(s) => { setSrc(s); r.setOutputs([]); }} />
      {src && (
        <div className="card space-y-3">
          <div className="grid gap-3 sm:grid-cols-2">
            {keys.map(([k, l]) => <Field key={k} label={l}><input className="input" value={meta[k] ?? ''} onChange={(e) => setMeta({ ...meta, [k]: e.target.value })} /></Field>)}
          </div>
          <div className="hint">建立：{dates.created?.toLocaleString() ?? '—'} · 修改：{dates.modified?.toLocaleString() ?? '—'}</div>
          <div className="flex flex-wrap gap-2">
            <button className="btn btn-primary" disabled={r.busy} onClick={() => r.run(async () => [{ name: outName(src.name, '_meta'), data: await writeMetadata(src.bytes, meta) }], { bytes: src.originalSize })}>儲存修改</button>
            <button className="btn btn-danger" disabled={r.busy} onClick={() => r.run(async () => [{ name: outName(src.name, '_clean'), data: await stripMetadata(src.bytes) }], { bytes: src.originalSize })}>🧹 徹底移除中繼資料</button>
          </div>
          <p className="hint">「徹底移除」會刪除 Info 字典、XMP、頁面 PieceInfo，並清除內嵌 JPEG 的 EXIF/GPS/裝置資訊（含不會顯示於上方欄位的內容）。</p>
        </div>
      )}
      <RunStatus r={r} /><Outputs items={r.outputs} beforeSize={src?.originalSize} />
    </div>
  );
}
