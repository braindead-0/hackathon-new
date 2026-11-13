import { useEffect, useState } from "react";
import { clinicalApi, type MobilePairing } from "./api";

export function MobileAlertPairing({ patientId }: { patientId: string }) {
  const [pairing, setPairing] = useState<(MobilePairing & { deadline: number }) | null>(null);
  const [status, setStatus] = useState<{ paired: number; connected: number } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [now, setNow] = useState(Date.now());

  useEffect(() => {
    let cancelled = false;
    let timer: number | undefined;
    const refresh = async () => {
      try {
        const next = await clinicalApi.mobileStatus(patientId);
        if (!cancelled) setStatus(next);
      } catch {
        if (!cancelled) setStatus(null);
      }
      if (!cancelled) {
        setNow(Date.now());
        timer = window.setTimeout(refresh, 3000);
      }
    };
    void refresh();
    return () => { cancelled = true; window.clearTimeout(timer); };
  }, [patientId]);

  const generateCode = async () => {
    setBusy(true);
    setError(null);
    try {
      const next = await clinicalApi.pairMobile(patientId);
      setPairing({ ...next, deadline: Date.now() + next.expires_in * 1000 });
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not create pairing code");
    } finally {
      setBusy(false);
    }
  };

  const expires = pairing ? Math.max(0, Math.ceil((pairing.deadline - now) / 60000)) : 0;
  const online = (status?.connected ?? 0) > 0;

  return (
    <div className="pairing-bar">
      <span className={`pairing-bar__dot${online ? " pairing-bar__dot--on" : ""}`} aria-hidden />
      <strong className="pairing-bar__name">VitalTrack phone</strong>
      <span className="pairing-bar__status" role="status">
        {status === null
          ? "checking connection…"
          : status.connected > 0
            ? `${status.connected} phone${status.connected > 1 ? "s" : ""} connected — alerts sync live`
            : status.paired > 0
              ? "paired · phone offline — reopen VitalTrack"
              : "not paired — ring and vibrate with abnormal alerts"}
      </span>
      <button type="button" className="btn btn--small" onClick={generateCode} disabled={busy}>
        {busy ? "Creating code…" : pairing ? "New code" : "Pair VitalTrack"}
      </button>
      {pairing && (
        <div className="pairing-bar__code">
          <span>
            In VitalTrack open <strong>Profile → Patient alert sync</strong>. Server{" "}
            {pairing.server_urls.length ? (
              <code>{pairing.server_urls[0]}</code>
            ) : (
              <em>unavailable — connect this computer to Wi-Fi</em>
            )}
            {" · "}code{" "}
            <strong className="pairing-bar__pin">{expires ? pairing.code : "expired"}</strong>
            {expires > 0 && <span className="muted"> · expires in {expires} min, single use</span>}
          </span>
        </div>
      )}
      <span className="pairing-bar__hint" title="Normal readings and sensor faults do not ring the phone.">
        Keep VitalTrack open with native alerts enabled — background delivery isn’t guaranteed.
      </span>
      {error && <div className="notice notice--warn" role="alert">{error}</div>}
    </div>
  );
}
