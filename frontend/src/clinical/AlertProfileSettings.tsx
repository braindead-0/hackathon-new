import { useEffect, useState } from "react";
import {
  clinicalApi,
  type AlertProfileIdentity,
  type AlertProfileSettings as Profile,
  type EmergencyContact,
} from "./api";
import type { AuthSession } from "./auth";

const EMPTY_CONTACT: EmergencyContact = { name: "", relation: "", phone: "" };

function identityOf(session: AuthSession): AlertProfileIdentity {
  return session.role === "doctor"
    ? {
        role: "doctor",
        clinician_id: session.clinicianId,
        display_name: session.clinicianName,
      }
    : {
        role: "patient",
        patient_id: session.patientId,
        display_name: session.patientName,
      };
}

export function AlertProfileSettings({ session }: { session: AuthSession }) {
  const identity = identityOf(session);
  const sessionName = session.role === "doctor" ? session.clinicianName : session.patientName;
  const [profile, setProfile] = useState<Profile | null>(null);
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [phone, setPhone] = useState("");
  const [contacts, setContacts] = useState<EmergencyContact[]>([]);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [status, setStatus] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    clinicalApi
      .getAlertProfile(identity)
      .then((value) => {
        if (cancelled) return;
        setProfile(value);
        setName(value.name ?? sessionName);
        setEmail(value.email ?? "");
        setPhone(value.phone ?? "");
        setContacts(value.contacts);
      })
      .catch((reason: unknown) => {
        if (cancelled) return;
        setProfile(null);
        setError(reason instanceof Error ? reason.message : "Could not load the alert profile.");
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
    // identity is rebuilt each render; its fields are what actually change
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [session]);

  const updateContact = (index: number, patch: Partial<EmergencyContact>) => {
    setContacts((current) =>
      current.map((contact, i) => (i === index ? { ...contact, ...patch } : contact)),
    );
  };

  const addContact = () => {
    const max = profile?.max_contacts ?? 6;
    if (contacts.length >= max) return;
    setContacts((current) => [...current, { ...EMPTY_CONTACT }]);
  };

  const removeContact = (index: number) => {
    setContacts((current) => current.filter((_, i) => i !== index));
  };

  const save = async () => {
    if (loading || saving) return;
    setSaving(true);
    setError(null);
    setStatus(null);
    try {
      const result = await clinicalApi.setAlertProfile({
        ...identity,
        name: name.trim() || null,
        email: email.trim() || null,
        phone: phone.trim() || null,
        contacts: contacts
          .map((contact) => ({
            name: contact.name.trim(),
            relation: contact.relation.trim(),
            phone: contact.phone.trim(),
          }))
          .filter((contact) => contact.name || contact.phone),
      });
      setProfile(result);
      setContacts(result.contacts);
      setStatus(
        result.phone
          ? `Saved. Urgent alerts go to ${result.phone}${
              result.contacts.length
                ? ` and ${result.contacts.length} emergency contact${result.contacts.length === 1 ? "" : "s"}.`
                : "."
            }`
          : result.default_phone
            ? `Saved. Your own alerts fall back to the server default ${result.default_phone}.`
            : "Saved. Alerts will only reach Telegram until a number is added.",
      );
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Could not save the alert profile.");
    } finally {
      setSaving(false);
    }
  };

  const maxContacts = profile?.max_contacts ?? 6;
  const summaryPhone = profile?.phone ?? profile?.default_phone ?? null;
  const summaryMeta = loading
    ? "loading…"
    : `${profile?.name || sessionName}${summaryPhone ? ` · ${summaryPhone}` : " · no number"}${
        profile?.contacts.length
          ? ` · ${profile.contacts.length} emergency contact${profile.contacts.length === 1 ? "" : "s"}`
          : " · no emergency contacts"
      }`;

  return (
    <details className="email-settings alert-profile" aria-label="Alert profile and emergency contacts">
      <summary className="email-settings__summary">
        <span className="email-settings__title">Alert profile &amp; emergency contacts</span>
        <span className="email-settings__meta small muted">{summaryMeta}</span>
        <span className="email-settings__toggle small">Configure</span>
      </summary>
      <div className="email-settings__body alert-profile__body">
        <div className="col" style={{ gap: 10 }}>
          <p className="small" style={{ margin: 0 }}>
            {session.role === "doctor"
              ? "Your number receives urgent clinical alerts and report edits. Family or colleagues listed below also get every urgent alert."
              : "Your number receives urgent alerts. Family members listed below are also messaged when an emergency alert fires."}
          </p>
          <div className="alert-profile__fields">
            <label>
              <span className="small">Full name</span>
              <input
                className="input"
                value={name}
                disabled={loading || saving}
                onChange={(event) => setName(event.target.value)}
              />
            </label>
            <label>
              <span className="small">WhatsApp number</span>
              <input
                className="input"
                type="tel"
                inputMode="tel"
                placeholder={profile?.default_phone ?? "+919876543210"}
                value={phone}
                disabled={loading || saving}
                onChange={(event) => setPhone(event.target.value)}
              />
            </label>
            <label>
              <span className="small">Email (optional)</span>
              <input
                className="input"
                type="email"
                placeholder="name@example.com"
                value={email}
                disabled={loading || saving}
                onChange={(event) => setEmail(event.target.value)}
              />
            </label>
          </div>
          <p className="small muted" style={{ margin: 0 }}>
            International format, e.g. +919876543210. Leave the number blank to use the server default
            {profile?.default_phone ? ` (${profile.default_phone})` : ""}. Telegram alerts are unaffected.
          </p>
        </div>

        <div className="col" style={{ gap: 8 }}>
          <div className="row row--tight" style={{ justifyContent: "space-between", alignItems: "center" }}>
            <span className="small">
              <strong>Family / emergency contacts</strong>
            </span>
            <button
              className="btn btn--small"
              onClick={addContact}
              disabled={loading || saving || contacts.length >= maxContacts}
            >
              + Add contact
            </button>
          </div>
          <p className="small muted" style={{ margin: 0 }}>
            Everyone listed here gets the urgent WhatsApp alert (NEWS2 in the urgent band). Up to{" "}
            {maxContacts}.
          </p>
          {contacts.map((contact, index) => (
            <div className="alert-contact" key={index}>
              <input
                className="input"
                aria-label={`Contact ${index + 1} name`}
                placeholder="Name"
                value={contact.name}
                disabled={saving}
                onChange={(event) => updateContact(index, { name: event.target.value })}
              />
              <input
                className="input"
                aria-label={`Contact ${index + 1} relationship`}
                placeholder="Relationship"
                value={contact.relation}
                disabled={saving}
                onChange={(event) => updateContact(index, { relation: event.target.value })}
              />
              <input
                className="input"
                type="tel"
                inputMode="tel"
                aria-label={`Contact ${index + 1} WhatsApp number`}
                placeholder="+91…"
                value={contact.phone}
                disabled={saving}
                onChange={(event) => updateContact(index, { phone: event.target.value })}
              />
              <button
                className="btn btn--small"
                aria-label={`Remove ${contact.name || `contact ${index + 1}`}`}
                disabled={saving}
                onClick={() => removeContact(index)}
              >
                ✕
              </button>
            </div>
          ))}
          {contacts.length === 0 && (
            <p className="small muted" style={{ margin: 0 }}>
              No family members added yet.
            </p>
          )}
          <button
            className="btn btn--small btn--primary"
            disabled={loading || saving}
            onClick={() => {
              void save();
            }}
          >
            {saving ? "Saving…" : "Save profile"}
          </button>
        </div>

        {(status || error) && (
          <p
            className={`small ${error ? "notice notice--warn" : "muted"} email-settings__status`}
            role="status"
          >
            {error ?? status}
          </p>
        )}
      </div>
    </details>
  );
}
