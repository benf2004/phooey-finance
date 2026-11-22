import { invoicePath } from "./paths";
import { useEffect, useRef, isValidElement, type ReactNode } from "react";
import { X, Upload, Trash2, FileText } from "lucide-react";
import {
  emptyParty,
  labelDefaults,
  type Branding,
  type Party,
} from "../shared/model";
import { api, prepareLogo, assetPath } from "./api";

export function Field({
  label,
  children,
  hint,
}: {
  label: ReactNode;
  children: ReactNode;
  hint?: string;
}) {
  const directControl =
    isValidElement(children) &&
    typeof children.type === "string" &&
    ["input", "select", "textarea"].includes(children.type);
  const content = (
    <>
      <span>{label}</span>
      {children}
      {hint && <small>{hint}</small>}
    </>
  );
  return directControl && typeof label === "string" ? (
    <label className="field">{content}</label>
  ) : (
    <div className="field">{content}</div>
  );
}
export function PartyFields({
  value,
  onChange,
  compact = false,
}: {
  value: Party;
  onChange: (p: Party) => void;
  compact?: boolean;
}) {
  const update = (key: keyof Party, text: string) =>
    onChange({ ...value, [key]: text });
  return (
    <div className={compact ? "party-inputs" : "form-grid"}>
      <Field label="Name">
        <input
          aria-label="Name"
          placeholder="Business or customer name"
          value={value.name}
          onChange={(e) => update("name", e.target.value)}
          maxLength={200}
        />
      </Field>
      <Field label="Address">
        <textarea
          aria-label="Address"
          placeholder="Street, city, postal code"
          value={value.address}
          onChange={(e) => update("address", e.target.value)}
          rows={3}
        />
      </Field>
      {compact ? (
        <details
          className="party-contact"
          open={value.email || value.phone || value.taxId ? true : undefined}
        >
          <summary>Contact details</summary>{" "}
          <Field label="Email">
            <input
              aria-label="Email"
              type="email"
              placeholder="hello@example.com"
              value={value.email}
              onChange={(e) => update("email", e.target.value)}
            />
          </Field>
          <Field label="Phone">
            <input
              aria-label="Phone"
              placeholder="Optional"
              value={value.phone}
              onChange={(e) => update("phone", e.target.value)}
            />
          </Field>
          <Field label="Tax / registration ID">
            <input
              aria-label="Tax / registration ID"
              placeholder="Optional"
              value={value.taxId}
              onChange={(e) => update("taxId", e.target.value)}
            />
          </Field>
        </details>
      ) : (
        <>
          {" "}
          <Field label="Email">
            <input
              aria-label="Email"
              type="email"
              placeholder="hello@example.com"
              value={value.email}
              onChange={(e) => update("email", e.target.value)}
            />
          </Field>
          <Field label="Phone">
            <input
              aria-label="Phone"
              placeholder="Optional"
              value={value.phone}
              onChange={(e) => update("phone", e.target.value)}
            />
          </Field>
          <Field label="Tax / registration ID">
            <input
              aria-label="Tax / registration ID"
              placeholder="Optional"
              value={value.taxId}
              onChange={(e) => update("taxId", e.target.value)}
            />
          </Field>
        </>
      )}
    </div>
  );
}
export function Modal({
  title,
  children,
  onClose,
}: {
  title: string;
  children: ReactNode;
  onClose: () => void;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const el = dialog.current;
    el?.showModal();
    return () => el?.close();
  }, []);
  return (
    <dialog ref={dialog} className="modal" onCancel={onClose}>
      <div className="modal-header">
        <h2>{title}</h2>
        <button
          className="icon-button"
          aria-label="Close dialog"
          onClick={onClose}
        >
          <X size={19} />
        </button>
      </div>
      {children}
    </dialog>
  );
}
export function Empty({
  title,
  description,
  children,
}: {
  title: string;
  description: string;
  children?: ReactNode;
}) {
  return (
    <div className="empty-state">
      <div className="empty-art">
        <FileText size={42} strokeWidth={1.3} />
        <span className="art-dot" />
      </div>
      <h2>{title}</h2>
      <p>{description}</p>
      {children}
    </div>
  );
}
type BrandingProps = {
  value: Branding;
  onChange: (v: Branding) => void;
  onError: (message: string) => void;
};
export function LogoField({ value, onChange, onError }: BrandingProps) {
  async function upload(file?: File) {
    if (!file) return;
    try {
      const blob = await prepareLogo(file);
      const asset = await api<{ id: string }>("/assets", {
        method: "POST",
        body: blob,
        headers: { "Content-Type": blob.type },
      });
      onChange({ ...value, logoAssetId: asset.id, logoData: null });
    } catch (e) {
      onError((e as Error).message);
    }
  }
  return (
    <div className="logo-upload">
      {value.logoAssetId || value.logoData ? (
        <>
          <img
            alt="Invoice logo"
            src={
              value.logoData ||
              assetPath(value.logoAssetId!)
            }
          />
          <button
            className="icon-button danger"
            aria-label="Remove logo"
            onClick={() =>
              onChange({ ...value, logoAssetId: null, logoData: null })
            }
          >
            <Trash2 size={16} />
          </button>
        </>
      ) : (
        <label className="upload-label">
          <Upload size={20} />
          <span>Add your logo</span>
          <small>PNG or JPEG</small>
          <input
            type="file"
            accept="image/png,image/jpeg"
            aria-label="Upload logo"
            onChange={(e) => {
              void upload(e.target.files?.[0]);
              e.target.value = "";
            }}
          />
        </label>
      )}
    </div>
  );
}
export function BrandingFields({
  value,
  onChange,
  onError,
  includeLogo = true,
}: BrandingProps & { includeLogo?: boolean }) {
  const update = <K extends keyof Branding>(key: K, v: Branding[K]) =>
    onChange({ ...value, [key]: v });
  return (
    <div className="branding-fields">
      {includeLogo && (
        <LogoField value={value} onChange={onChange} onError={onError} />
      )}
      <Field label="Template">
        <div className="template-options">
          {(["classic", "modern"] as const).map((t) => (
            <button
              key={t}
              className={`template-choice ${value.template === t ? "selected" : ""}`}
              onClick={() => update("template", t)}
              aria-pressed={value.template === t}
            >
              <div className={`mini-paper ${t}`}>
                <i />
                <b />
                <span />
                <span />
                <span />
              </div>
              {t === "classic" ? "Classic" : "Modern"}
            </button>
          ))}
        </div>
      </Field>
      <Field label="Accent color">
        <div className="color-input">
          <input
            type="color"
            value={value.accentColor}
            aria-label="Accent color"
            onChange={(e) => update("accentColor", e.target.value)}
          />
          <input
            value={value.accentColor}
            aria-label="Accent color hex"
            pattern="#[a-fA-F0-9]{6}"
            onChange={(e) => update("accentColor", e.target.value)}
          />
        </div>
      </Field>
      <div className="form-grid two">
        <Field label="Font">
          <select
            value={value.font}
            onChange={(e) => update("font", e.target.value as Branding["font"])}
          >
            <option value="sans">Noto Sans</option>
            <option value="serif">Noto Serif</option>
            <option value="mono">Noto Mono</option>
          </select>
        </Field>
        <Field label="Paper size">
          <select
            value={value.paper}
            onChange={(e) =>
              update("paper", e.target.value as Branding["paper"])
            }
          >
            <option value="letter">US Letter</option>
            <option value="a4">A4</option>
          </select>
        </Field>
      </div>
      <details className="customize-details">
        <summary>Optional sections</summary>
        <div className="checks">
          {(["showShipping", "showNotes", "showTerms"] as const).map((key) => (
            <label key={key}>
              <input
                type="checkbox"
                checked={value[key]}
                onChange={(e) => update(key, e.target.checked)}
              />
              {
                {
                  showShipping: "Shipping address",
                  showNotes: "Notes",
                  showTerms: "Terms",
                }[key]
              }
            </label>
          ))}
        </div>
      </details>
      <details className="customize-details">
        <summary>Edit invoice labels</summary>
        <div className="labels-grid">
          {(
            Object.keys(labelDefaults) as Array<keyof typeof labelDefaults>
          ).map((key) => (
            <Field label={labelDefaults[key]} key={key}>
              <input
                maxLength={64}
                value={value.labels[key] ?? labelDefaults[key]}
                onChange={(e) =>
                  update("labels", { ...value.labels, [key]: e.target.value })
                }
              />
            </Field>
          ))}
        </div>
      </details>
    </div>
  );
}
export { emptyParty };
