import { useEffect, useState } from "react";
import { clinicalApi, type ReportAutomation } from "./api";
import type { AuthSession } from "./auth";

export function ReportEmailSettings({ session }: { session: AuthSession }) {
  const [settings, setSettings] = useState<ReportAutomation | null>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [revision, setRevision] = useState(0);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    clinicalApi.getReportAutomation()
      .then((value) => { if (!cancelled) setSettings(value); })
      .catch((reason: unknown) => {
        if (!cancelled) {
          setSettings(null);
          setError(reason instanceof Error ? reason.message : "Could not load email settings.");
        }
      })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [revision]);

  const toggle = async (enabled: boolean) => {
    if (loading || saving || !settings?.available) return;
    setSaving(true);
    setError(null);
    try {
      const result = await clinicalApi.setReportAutomation({ enabled });
      setSettings((previous) => previous && { ...previous, enabled: result.enabled });
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Could not save weekly email setting.");
    } finally {
      setSaving(false);
    }
  };

  // GET's email belongs to the global active session, which may be another tab.
  const email = session.email?.trim();
  return (
    <details className="email-settings" aria-label="Report email settings">
      <summary className="email-settings__summary">
        <span className="email-settings__title">Report email delivery</span>
        <span className="email-settings__meta small muted">
          {email ?? (settings ? `${settings.default_email} (server default)` : "loading recipient…")}
          {settings ? ` · weekly emails ${settings.enabled ? "on" : "off"}` : ""}
          {!loading && settings && !settings.available ? " · email unavailable" : ""}
        </span>
        <span className="email-settings__toggle small">Configure</span>
      </summary>
      <div className="email-settings__body">
        <div>
          <p className="small" style={{ margin: "0 0 4px" }}>
            {email ? `Email provided at sign-in: ${email}` : settings
              ? `Optional email left blank: using ${settings.default_email} (server default).`
              : "Optional email left blank: the server default recipient will be used."}
          </p>
          <p className="small muted" style={{ margin: 0 }}>
            Every Generate click requests a PDF email, even when weekly emails are off. To change your address, sign out and sign in again.
          </p>
        </div>
        <div className="col" style={{ gap: 8 }}>
          <label className="row row--tight small" style={{ alignItems: "center" }}>
            <input
              type="checkbox"
              checked={settings?.enabled ?? false}
              disabled={loading || saving || !settings?.available}
              onChange={(event) => { void toggle(event.target.checked); }}
            />
            Weekly emails for all registered recipients
          </label>
          <span className="small muted">Global setting, not a personal subscription.</span>
          <button className="btn btn--small" disabled={loading || saving} onClick={() => setRevision((value) => value + 1)}>
            Refresh email settings
          </button>
        </div>
        <p className="small muted email-settings__status" role="status">
          {loading ? "Loading email availability and weekly setting…" : saving ? "Saving global weekly setting…"
            : !settings ? "Email availability unknown."
            : settings.available ? `Email service configured. Weekly emails ${settings.enabled ? "on" : "off"}. Provider recipient restrictions may still apply.`
            : "Email service unavailable: server email configuration is required. Weekly toggle is disabled."}
        </p>
        {error && <p className="notice notice--warn small" role="alert">Email settings: {error}</p>}
      </div>
    </details>
  );
}
