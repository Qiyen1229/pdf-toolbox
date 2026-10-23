import { useEffect, useState } from 'react';
import { Alert, Field, Outputs, PdfPicker, RunStatus, Spinner, outName, useRunner, usePdfDoc, type PdfSource } from '../../components/common';
import { PageNav, PageStage, type Pt } from '../../components/PageStage';
import { listFormFields, fillForm, flattenForm, createFormFields, type FormFieldInfo, type NewField } from '../ops/forms';
import { readBytes } from '../../lib/files';

export function FormFill({ id }: { id: string }) {
  const [src, setSrc] = useState<PdfSource | null>(null);
  const [fields, setFields] = useState<FormFieldInfo[] | null>(null);
  const [vals, setVals] = useState<Record<string, string | boolean | string[]>>({});
  const [flatten, setFlatten] = useState(false);
  const [font, setFont] = useState<File | null>(null);
  const [err, setErr] = useState('');
  const r = useRunner(id);
  useEffect(() => {
    setFields(null); setVals({}); setErr('');
    if (!src) return;
    listFormFields(src.bytes).then((f) => { setFields(f); setVals(Object.fromEntries(f.map((x) => [x.name, x.value]))); }).catch((e) => setErr(e.message));
  }, [src]);
  const editable = fields?.filter((f) => !['button', 'signature', 'unknown'].includes(f.type)) ?? [];
  return (
    <div className="space-y-4">
      <PdfPicker value={src} onChange={(s) => { setSrc(s); r.setOutputs([]); }} />
      {err && <Alert kind="error">{err}</Alert>}
      {src && fields && editable.length === 0 && <Alert kind="info">此 PDF 沒有 AcroForm 欄位。可使用「建立表單欄位」工具新增，或用「註解與標記」在頁面上直接輸入文字。</Alert>}
      {src && editable.length > 0 && (
        <div className="card space-y-4">
          <div className="grid gap-3 sm:grid-cols-2">
            {editable.map((f) => (
              <Field key={f.name} label={`${f.name}${f.readOnly ? '（唯讀）' : ''}`}>
                {f.type === 'text' && (f.multiline ? <textarea className="input" rows={3} disabled={f.readOnly} value={String(vals[f.name] ?? '')} onChange={(e) => setVals({ ...vals, [f.name]: e.target.value })} />
                  : <input className="input" disabled={f.readOnly} value={String(vals[f.name] ?? '')} onChange={(e) => setVals({ ...vals, [f.name]: e.target.value })} />)}
                {f.type === 'checkbox' && <input type="checkbox" className="h-5 w-5" disabled={f.readOnly} checked={!!vals[f.name]} onChange={(e) => setVals({ ...vals, [f.name]: e.target.checked })} />}
                {(f.type === 'radio' || f.type === 'dropdown') && (
                  <select className="input" disabled={f.readOnly} value={String(vals[f.name] ?? '')} onChange={(e) => setVals({ ...vals, [f.name]: e.target.value })}>
                    <option value="">（未選）</option>{f.options?.map((o) => <option key={o}>{o}</option>)}
                  </select>
                )}
                {f.type === 'list' && (
                  <select multiple className="input" disabled={f.readOnly} value={(vals[f.name] as string[]) ?? []} onChange={(e) => setVals({ ...vals, [f.name]: [...e.target.selectedOptions].map((o) => o.value) })}>
                    {f.options?.map((o) => <option key={o}>{o}</option>)}
                  </select>
                )}
              </Field>
            ))}
          </div>
          <Field label="自訂 CJK 字型檔（選填）" hint="已預設啟用 PDF 標準中文相容模式，可直接輸入中文輸出；若需特定外觀或需要「輸出後扁平化」，可在此上傳自訂 .ttf/.otf 字型檔。">
            <input type="file" accept=".ttf,.otf" className="input" onChange={(e) => setFont(e.target.files?.[0] ?? null)} />
          </Field>
          <label className="flex items-center gap-2 text-sm"><input type="checkbox" checked={flatten} onChange={(e) => setFlatten(e.target.checked)} /> 輸出後扁平化（欄位變為固定內容，不可再編輯）</label>
          <button className="btn btn-primary" disabled={r.busy} onClick={() => r.run(async () => [{
            name: outName(src.name, flatten ? '_filled_flat' : '_filled'),
            data: await fillForm(src.bytes, vals, { flatten, fontBytes: font ? await readBytes(font) : undefined }),
          }], { bytes: src.originalSize })}>{r.busy ? <Spinner /> : '✍️'} 填寫並輸出</button>
        </div>
      )}
      {src && fields && fields.length > 0 && (
        <button className="btn" disabled={r.busy} onClick={() => r.run(async () => [{ name: outName(src.name, '_flattened'), data: await flattenForm(src.bytes) }], { bytes: src.originalSize })}>僅扁平化（不修改內容）</button>
      )}
      <RunStatus r={r} /><Outputs items={r.outputs} beforeSize={src?.originalSize} />
    </div>
  );
}

const KINDS: { k: NewField['kind']; l: string; w: number; h: number }[] = [
  { k: 'text', l: '文字', w: 160, h: 24 }, { k: 'multiline', l: '多行文字', w: 200, h: 70 }, { k: 'checkbox', l: '勾選', w: 16, h: 16 },
  { k: 'radio', l: '單選', w: 16, h: 16 }, { k: 'dropdown', l: '下拉選單', w: 140, h: 24 }, { k: 'date', l: '日期', w: 110, h: 24 },
];
export function FormCreate({ id }: { id: string }) {
  const [src, setSrc] = useState<PdfSource | null>(null);
  const { doc } = usePdfDoc(src?.bytes ?? null);
  const [page, setPage] = useState(0);
  const [kind, setKind] = useState<NewField['kind']>('text');
  const [fields, setFields] = useState<(NewField & { key: string })[]>([]);
  const [options, setOptions] = useState('選項 1, 選項 2, 選項 3');
  const [groupName, setGroupName] = useState('group1');
  const r = useRunner(id);
  const place = (p: Pt) => {
    const d = KINDS.find((x) => x.k === kind)!;
    const n = fields.filter((f) => f.kind === kind).length + 1;
    const name = kind === 'radio' ? groupName : `${kind}_${n}`;
    setFields((a) => [...a, { key: crypto.randomUUID(), kind, name, page, x: p.x, y: p.y, w: d.w, h: d.h, options: kind === 'radio' ? [`選項${a.filter((f) => f.kind === 'radio' && f.name === groupName).length + 1}`] : kind === 'dropdown' ? options.split(/[,，]/).map((s) => s.trim()).filter(Boolean) : undefined }]);
  };
  const run = () => r.run(async () => {
    // 同一個單選群組的選項合併成一個欄位（逐個加入 widget）
    const flat: NewField[] = fields.map(({ key, ...f }) => f);
    return [{ name: outName(src!.name, '_form'), data: await createFormFields(src!.bytes, flat) }];
  }, { bytes: src?.originalSize });
  return (
    <div className="space-y-4">
      <PdfPicker value={src} onChange={(s) => { setSrc(s); setFields([]); r.setOutputs([]); setPage(0); }} />
      {src && doc && (
        <>
          <div className="card space-y-3">
            <div className="flex flex-wrap items-center gap-2">
              {KINDS.map((k) => <button key={k.k} className={`btn btn-sm ${kind === k.k ? 'btn-primary' : ''}`} onClick={() => setKind(k.k)}>{k.l}</button>)}
              <span className="hint">選好類型後，在頁面上點一下即可放置欄位</span>
            </div>
            {kind === 'dropdown' && <Field label="選項（逗號分隔）"><input className="input" value={options} onChange={(e) => setOptions(e.target.value)} /></Field>}
            {kind === 'radio' && <Field label="單選群組名稱" hint="同名稱的單選按鈕為同一組，只能選一個"><input className="input" value={groupName} onChange={(e) => setGroupName(e.target.value)} /></Field>}
            <PageNav page={page} total={src.pages} onChange={setPage} />
          </div>
          <div className="overflow-auto rounded-lg bg-slate-200 p-3 dark:bg-slate-800" style={{ maxHeight: '70vh' }}>
            <PageStage pdf={doc} pageIndex={page} scale={1} cursor="copy" onDown={place} lockTouch>
              {({ scale }) => fields.filter((f) => f.page === page).map((f) => (
                <div key={f.key} className="absolute border border-brand-600 bg-brand-500/15 text-[10px] text-brand-700" style={{ left: f.x * scale, top: f.y * scale, width: f.w * scale, height: f.h * scale }} onPointerDown={(e) => e.stopPropagation()}>
                  <span className="absolute -top-4 left-0 whitespace-nowrap rounded bg-brand-500 px-1 text-black">{f.name}</span>
                </div>
              ))}
            </PageStage>
          </div>
          {fields.length > 0 && (
            <div className="card space-y-2">
              <div className="text-sm font-semibold">已放置 {fields.length} 個欄位</div>
              {fields.map((f) => (
                <div key={f.key} className="flex flex-wrap items-center gap-2">
                  <span className="chip">第 {f.page + 1} 頁 · {KINDS.find((k) => k.k === f.kind)!.l}</span>
                  <input className="input !min-h-8 !w-44" value={f.name} onChange={(e) => setFields((a) => a.map((x) => (x.key === f.key ? { ...x, name: e.target.value } : x)))} aria-label="欄位名稱" />
                  {f.kind === 'radio' && <input className="input !min-h-8 !w-28" value={f.options?.[0] ?? ''} onChange={(e) => setFields((a) => a.map((x) => (x.key === f.key ? { ...x, options: [e.target.value] } : x)))} aria-label="選項標籤" />}
                  <button className="btn btn-sm" onClick={() => setFields((a) => a.filter((x) => x.key !== f.key))}>刪除</button>
                </div>
              ))}
            </div>
          )}
          <button className="btn btn-primary" disabled={r.busy || !fields.length} onClick={() => void run()}>{r.busy ? <Spinner /> : '🧱'} 建立欄位並輸出</button>
        </>
      )}
      <RunStatus r={r} /><Outputs items={r.outputs} beforeSize={src?.originalSize} />
    </div>
  );
}
