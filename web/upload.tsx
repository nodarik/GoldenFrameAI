// The page behind a scene's upload link (/u/<token>): no account, just the scene, a name and a camera button.
// People see that each file arrived; the inspection results stay with the reviewers in the app.
import { type FormEvent, useEffect, useRef, useState } from "react";
import { MAX_VIDEO_BYTES, api, uploadForm } from "./api.js";

const MAX_PHOTO_BYTES = 15 * 1024 * 1024;
const NAME_KEY = "ts_uploader";
type LinkInfo = { sceneName: string; golden: { w: number; h: number } | null };
type Sent = { key: number; file: File; name: string; pct: number; state: "sending" | "done" | "failed"; error?: string; retry: boolean };

const savedName = () => {
  try { return localStorage.getItem(NAME_KEY) ?? ""; } catch { return ""; }
};
const saveName = (n: string) => {
  try { localStorage.setItem(NAME_KEY, n); } catch { /* private mode: ask again next time */ }
};

// Phones sometimes hand over a file without a type; the extension tells.
const TYPES: Record<string, string> = {
  jpg: "image/jpeg", jpeg: "image/jpeg", png: "image/png", webp: "image/webp",
  mp4: "video/mp4", m4v: "video/mp4", mov: "video/quicktime", webm: "video/webm",
};
function typed(file: File): File | null {
  if (/^(image|video)\//.test(file.type)) return file;
  const type = TYPES[file.name.split(".").pop()?.toLowerCase() ?? ""];
  return type ? new File([file], file.name, { type }) : null;
}

export function UploadPage({ token }: { token: string }) {
  const [info, setInfo] = useState<LinkInfo | null>(null);
  const [error, setError] = useState("");
  const [name, setName] = useState(savedName);
  const [draft, setDraft] = useState(name);
  const [sent, setSent] = useState<Sent[]>([]);
  const nextKey = useRef(0);
  const photoRef = useRef<HTMLInputElement>(null), videoRef = useRef<HTMLInputElement>(null), pickRef = useRef<HTMLInputElement>(null);
  const base = `/api/link/${encodeURIComponent(token)}`;

  useEffect(() => { api<LinkInfo>(base).then(setInfo).catch((e) => setError(e.message)); }, [base]);
  useEffect(() => { if (info) document.title = `Send to ${info.sceneName} · TrueScene`; }, [info]);

  const update = (key: number, patch: Partial<Sent>) => setSent((all) => all.map((s) => (s.key === key ? { ...s, ...patch } : s)));
  const send = async (item: Sent) => {
    update(item.key, { state: "sending", pct: 0, error: undefined });
    try {
      const q = new URLSearchParams({ by: name, name: item.name.replace(/\.[^.]+$/, "").slice(0, 80) || "Video" });
      await uploadForm(`${base}?${q}`, item.file, (pct) => update(item.key, { pct }));
      update(item.key, { state: "done", pct: 100 });
    } catch (e) {
      update(item.key, { state: "failed", error: (e as Error).message, retry: true });
    }
  };
  const add = (files: FileList | null) => {
    for (const raw of Array.from(files ?? [])) {
      const file = typed(raw);
      const item: Sent = { key: nextKey.current++, file: file ?? raw, name: raw.name, pct: 0, state: "sending", retry: false };
      const video = file?.type.startsWith("video/");
      if (!file) item.error = "Only photos and videos can be sent.";
      else if (file.size > (video ? MAX_VIDEO_BYTES : MAX_PHOTO_BYTES))
        item.error = video ? "Videos must be 200 MB or smaller. Record a shorter clip." : "Photos must be 15 MB or smaller.";
      if (item.error) item.state = "failed";
      setSent((all) => [item, ...all]);
      if (!item.error) void send(item);
    }
  };
  const keepName = (e: FormEvent) => {
    e.preventDefault();
    const n = draft.trim().slice(0, 60);
    if (!n) return;
    saveName(n);
    setName(n);
  };

  if (error) return <div className="center"><div className="upload-card"><h1>Upload link</h1><p className="err" role="alert">{error}</p></div></div>;
  if (!info) return <div className="center"><span className="spinner" aria-label="Loading" /></div>;
  const busy = sent.some((s) => s.state === "sending");
  const pick = (input: HTMLInputElement) => { add(input.files); input.value = ""; };

  return (
    <main className="upload-page">
      <div className="upload-card">
        <p className="muted small upload-brand">TrueScene</p>
        <h1>{info.sceneName}</h1>
        {info.golden && (
          <figure className="upload-golden">
            <img src={`${base}/golden.jpg`} width={info.golden.w} height={info.golden.h} alt={`How ${info.sceneName} should look`} />
            <figcaption className="muted small">Take your photo or video from about here, so it matches this view.</figcaption>
          </figure>
        )}

        {!name ? (
          <form onSubmit={keepName} className="form">
            <label htmlFor="uploader">Who's sending?</label>
            <input id="uploader" value={draft} maxLength={60} autoComplete="name" placeholder="Your name" onChange={(e) => setDraft(e.target.value)} autoFocus />
            <button className="primary big" disabled={!draft.trim()}>Continue</button>
          </form>
        ) : (
          <>
            <p className="muted small">Sending as <strong>{name}</strong> · <button type="button" className="link" onClick={() => { setDraft(name); setName(""); }}>Not you?</button></p>
            <div className="upload-actions">
              <button type="button" className="primary big" onClick={() => photoRef.current?.click()}>Take photo</button>
              <button type="button" className="big" onClick={() => videoRef.current?.click()}>Record video</button>
              <button type="button" className="ghost" onClick={() => pickRef.current?.click()}>Choose from library</button>
            </div>
            <input ref={photoRef} type="file" accept="image/*" capture="environment" hidden onChange={(e) => pick(e.target)} />
            <input ref={videoRef} type="file" accept="video/*" capture="environment" hidden onChange={(e) => pick(e.target)} />
            <input ref={pickRef} type="file" accept="image/*,video/*" multiple hidden onChange={(e) => pick(e.target)} />
            <p className="muted small">Photos up to 15 MB, videos up to 200 MB. Keep videos short on mobile data.</p>
          </>
        )}

        {sent.length > 0 && (
          <ul className="upload-list" aria-live="polite">
            {sent.map((s) => (
              <li key={s.key}>
                <span className="upload-name">{s.name}</span>
                {s.state === "sending" && <span className="muted small">Sending… {s.pct}%</span>}
                {s.state === "done" && <span className="upload-ok">Received ✓</span>}
                {s.state === "failed" && (
                  <span className="err small">{s.error}{s.retry && <> · <button type="button" className="link" onClick={() => void send(s)}>Try again</button></>}</span>
                )}
                {s.state === "sending" && <progress max={100} value={s.pct} aria-label={`Sending ${s.name}`} />}
              </li>
            ))}
          </ul>
        )}
        {busy && <p className="muted small">Keep this page open until everything says Received.</p>}
      </div>
    </main>
  );
}
