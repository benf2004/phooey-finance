import { AutoTextarea, InvoiceParty } from "./invoice-fields";
import { invoicePath } from "./paths";
import { useEffect, useState, lazy, Suspense } from "react";
import {
  ArrowLeft,
  Plus,
  Trash2,
  Download,
  Eye,
  Pencil,
  Check,
  Copy,
  Archive,
  RotateCcw,
  Ban,
  Save,
  RefreshCw,
} from "lucide-react";
import {
  api,
  allPages,
  body,
  downloadBytes,
  businessHeaders,
  assetPath,
} from "./api";
import { BrandingFields, LogoField, Field, Modal, Empty } from "./components";
import {
  calculate,
  currencies,
  documentSchema,
  labelDefaults,
  money,
  newDocument,
  type Customer,
  type Invoice,
  type InvoiceDocument,
  type Preset,
  type SettingsRecord,
  type Totals,
  type LabelKey,
} from "../shared/model";

const PdfViewer = lazy(() => import("./pdf-viewer"));
const fontCache = new Map<string, Promise<Uint8Array>>();
function loadFont(name: string) {
  let promise = fontCache.get(name);
  if (!promise) {
    promise = fetch(invoicePath(`/fonts/${name}`)).then(async (r) => {
      if (!r.ok) throw new Error("PDF fonts are unavailable");
      return new Uint8Array(await r.arrayBuffer());
    });
    fontCache.set(name, promise);
    promise.catch(() => fontCache.delete(name));
  }
  return promise;
}
async function makePdf(doc: InvoiceDocument, state?: Invoice["status"]) {
  const parsed = documentSchema.parse(doc);
  let logo: Uint8Array | undefined;
  if (parsed.branding.logoAssetId) {
    const res = await fetch(
      invoicePath(`/api/v1/assets/${parsed.branding.logoAssetId}`),
      { headers: businessHeaders() },
    );
    if (!res.ok) throw new Error("Logo could not be loaded");
    logo = new Uint8Array(await res.arrayBuffer());
  }
  const { renderPdf } = await import("../shared/pdf");
  return renderPdf(parsed, { font: loadFont, logo, state });
}
export function Editor({
  id,
  navigate,
  onDirtyChange,
  onDraftCreated,
  notify,
}: {
  id?: string;
  navigate: (path: string) => void;
  onDirtyChange: (dirty: boolean) => void;
  onDraftCreated: (path: string) => void;
  notify: (m: string, error?: boolean) => void;
}) {
  const [doc, setDoc] = useState<InvoiceDocument>(newDocument());
  const [saved, setSaved] = useState<Invoice>();
  const [customers, setCustomers] = useState<Customer[]>([]);
  const [presets, setPresets] = useState<Preset[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState("");
  const [busy, setBusy] = useState(false);
  const [dirty, setDirty] = useState(false);
  const [preview, setPreview] = useState(false);
  const [pdfBytes, setPdfBytes] = useState<Uint8Array>();
  const [pdfError, setPdfError] = useState("");
  const [payment, setPayment] = useState(false);
  const [paidValue, setPaidValue] = useState("");
  const [confirmIssue, setConfirmIssue] = useState(false);
  const [presetId, setPresetId] = useState("");
  const [showDiscount, setShowDiscount] = useState(false);
  const [showShippingCharge, setShowShippingCharge] = useState(false);
  const editable = !saved || (saved.status === "draft" && !saved.archivedAt);
  useEffect(() => {
    let active = true;
    Promise.all([
      api<SettingsRecord>("/settings"),
      allPages<Customer>("/customers"),
      allPages<Preset>("/presets"),
      id ? api<Invoice>(`/invoices/${id}`) : Promise.resolve(undefined),
    ])
      .then(([record, clients, styles, invoice]) => {
        if (!active) return;
        setCustomers(clients);
        setPresets(styles);
        if (invoice) {
          setSaved(invoice);
          setDoc(invoice.document);
        } else {
          const initial = newDocument(record.settings);
          const preset = styles.find(
            (p) => p.id === record.settings.defaultPresetId,
          );
          if (preset) {
            initial.branding = {
              ...initial.branding,
              ...preset.branding,
              labels: { ...initial.branding.labels, ...preset.branding.labels },
            };
            setPresetId(preset.id);
          }
          setDoc(initial);
        }
        setLoading(false);
      })
      .catch((e) => {
        if (active) {
          notify(e.message, true);
          setLoadError(e.message);
          setLoading(false);
        }
      });
    return () => {
      active = false;
    };
  }, [id]);
  useEffect(() => {
    onDirtyChange(dirty);
    const handler = (e: BeforeUnloadEvent) => {
      if (dirty) e.preventDefault();
    };
    window.addEventListener("beforeunload", handler);
    return () => {
      onDirtyChange(false);
      window.removeEventListener("beforeunload", handler);
    };
  }, [dirty]);
  useEffect(() => {
    if (!preview || loading) return;
    let active = true;
    setPdfError("");
    setPdfBytes(undefined);
    const timer = setTimeout(() => {
      makePdf(doc, saved?.status)
        .then((bytes) => {
          if (!active) return;
          setPdfBytes(bytes);
        })
        .catch((e) => {
          if (active) setPdfError(e.message);
        });
    }, 400);
    return () => {
      active = false;
      clearTimeout(timer);
    };
  }, [doc, preview, loading, saved?.status]);
  const update = <K extends keyof InvoiceDocument>(
    key: K,
    value: InvoiceDocument[K],
  ) => {
    setDoc((d) => ({ ...d, [key]: value }));
    setDirty(true);
  };
  async function run(work: () => Promise<void>) {
    setBusy(true);
    try {
      await work();
      return true;
    } catch (e) {
      notify((e as Error).message, true);
      return false;
    } finally {
      setBusy(false);
    }
  }
  async function save(issue = false) {
    await run(async () => {
      documentSchema.parse(doc);
      calculate(doc);
      let invoice: Invoice;
      if (saved)
        invoice = await api<Invoice>(`/invoices/${saved.id}`, {
          method: "PUT",
          body: body({ ...doc, revision: saved.revision }),
        });
      else
        invoice = await api<Invoice>("/invoices", {
          method: "POST",
          body: body({ ...doc, status: issue ? "issued" : "draft" }),
        });
      setSaved(invoice);
      setDoc(invoice.document);
      setDirty(false);
      if (issue && invoice.status === "draft") {
        invoice = await api<Invoice>(`/invoices/${invoice.id}/issue`, {
          method: "POST",
          body: body({ revision: invoice.revision }),
        });
        setSaved(invoice);
        setDoc(invoice.document);
      }
      if (!id) {
        onDraftCreated(`/invoices/${invoice.id}`);
      }
      notify(issue ? "Invoice issued." : "Draft saved.");
    });
  }
  async function action(name: string, extra: object = {}) {
    if (!saved) return false;
    return run(async () => {
      const result = await api<Invoice>(`/invoices/${saved.id}/${name}`, {
        method: "POST",
        body: body({ revision: saved.revision, ...extra }),
      });
      if (name === "duplicate") {
        navigate(`/invoices/${result.id}`);
        notify("A fresh draft is ready.");
      } else {
        setSaved(result);
        setDoc(result.document);
        setDirty(false);
        notify(
          `Invoice ${name === "payment" ? "payment updated" : name === "archive" ? "archived" : name === "restore" ? "restored" : "voided"}.`,
        );
      }
    });
  }
  let totals: Totals | undefined;
  let calculationError = "";
  try {
    totals = calculate(documentSchema.parse(doc));
  } catch (e) {
    calculationError =
      e instanceof Error && !("issues" in e)
        ? e.message
        : "Complete the required invoice fields to calculate totals.";
  }
  const labels = { ...labelDefaults, ...doc.branding.labels };
  const label = (key: LabelKey) => (
    <input
      className={`editable-label label-${key}`}
      aria-label={`${labelDefaults[key]} label`}
      maxLength={64}
      value={labels[key]}
      onChange={(e) =>
        update("branding", {
          ...doc.branding,
          labels: { ...doc.branding.labels, [key]: e.target.value },
        })
      }
      onBlur={(e) => {
        if (!e.target.value.trim())
          update("branding", {
            ...doc.branding,
            labels: { ...doc.branding.labels, [key]: labelDefaults[key] },
          });
      }}
    />
  );
  const currencySymbol =
    new Intl.NumberFormat(doc.locale, {
      style: "currency",
      currency: doc.currency,
    })
      .formatToParts(0)
      .find((part) => part.type === "currency")?.value || doc.currency;
  const format = (n: number) => money(n, doc.currency, doc.locale, "symbol");
  const back = () => {
    if (
      !dirty ||
      window.confirm("Leave this invoice? Unsaved changes will be lost.")
    )
      navigate("/");
  };
  if (loading)
    return <div className="loading-state">Preparing your invoice…</div>;
  if (loadError)
    return (
      <div className="panel">
        <Empty title="Invoice could not be opened" description={loadError}>
          <button className="button" onClick={() => navigate("/")}>
            Back to invoices
          </button>
        </Empty>
      </div>
    );
  return (
    <>
      <div className="editor-heading">
        <button className="back-link" onClick={back}>
          <ArrowLeft size={15} /> All invoices
        </button>
        <h1>{saved?.number || (saved ? "Draft invoice" : "New invoice")}</h1>
        {dirty && (
          <span className="unsaved" role="status">
            Unsaved changes
          </span>
        )}
      </div>
      <div className="editor-layout">
        <div className="invoice-workspace">
          {preview ? (
            <div className="pdf-preview">
              {pdfError ? (
                <div role="alert" className="inline-error">
                  {pdfError}
                </div>
              ) : pdfBytes ? (
                <Suspense
                  fallback={
                    <div className="loading-state">Loading PDF viewer…</div>
                  }
                >
                  <PdfViewer data={pdfBytes} />
                </Suspense>
              ) : (
                <div className="loading-state">Rendering your PDF…</div>
              )}
            </div>
          ) : (
            <fieldset
              className={`invoice-paper ${doc.branding.template}`}
              disabled={!editable || busy}
              style={
                {
                  "--invoice-accent": doc.branding.accentColor,
                  fontFamily: {
                    sans: "Inter, sans-serif",
                    serif: "Noto Serif, serif",
                    mono: "Noto Sans Mono, monospace",
                  }[doc.branding.font],
                } as React.CSSProperties
              }
            >
              <div className="paper-header">
                {editable ? (
                  <LogoField
                    value={doc.branding}
                    onChange={(value) => {
                      setPresetId("");
                      update("branding", value);
                    }}
                    onError={(m) => notify(m, true)}
                  />
                ) : doc.branding.logoData || doc.branding.logoAssetId ? (
                  <img
                    className="paper-logo"
                    alt="Business logo"
                    src={
                      doc.branding.logoData ||
                      assetPath(doc.branding.logoAssetId!)
                    }
                  />
                ) : (
                  <span />
                )}
                <h2>{label("title")}</h2>
                <label className="paper-invoice-number">
                  <span aria-hidden="true">#</span>
                  <input
                    style={{
                      width: `${(doc.invoiceNumber || "Assigned when issued").length}ch`,
                    }}
                    aria-label="Invoice number"
                    placeholder="Assigned when issued"
                    value={doc.invoiceNumber}
                    onChange={(e) => update("invoiceNumber", e.target.value)}
                  />
                </label>
              </div>
              <div className="paper-top">
                <div className="paper-people">
                  <div className="paper-party">
                    <InvoiceParty
                      value={doc.business}
                      onChange={(p) => update("business", p)}
                      label="From"
                      placeholder="Who is this from?"
                    />
                  </div>
                  <div className="paper-parties">
                    <section>
                      <div className="party-heading">
                        {label("billTo")}
                        {customers.length > 0 && (
                          <select
                            aria-label="Choose customer"
                            value=""
                            onChange={(e) => {
                              const customer = customers.find(
                                (c) => c.id === e.target.value,
                              );
                              if (customer)
                                update("billTo", { ...customer.party });
                            }}
                          >
                            <option value="">Saved</option>
                            {customers.map((c) => (
                              <option key={c.id} value={c.id}>
                                {c.party.name}
                              </option>
                            ))}
                          </select>
                        )}
                      </div>
                      <InvoiceParty
                        value={doc.billTo}
                        onChange={(p) => update("billTo", p)}
                        label="Bill to"
                        placeholder="Who is this to?"
                      />
                    </section>
                    <section>
                      {label("shipTo")}
                      <InvoiceParty
                        value={
                          (doc.branding.showShipping && doc.shipTo) || {
                            name: "",
                            address: "",
                            email: "",
                            phone: "",
                            taxId: "",
                          }
                        }
                        onChange={(p) => {
                          setDoc((d) => ({
                            ...d,
                            shipTo: p,
                            branding: { ...d.branding, showShipping: true },
                          }));
                          setDirty(true);
                        }}
                        label="Ship to"
                        placeholder="(optional)"
                      />
                    </section>
                  </div>
                </div>
                <div className="paper-meta">
                  <Field label={label("date")}>
                    <input
                      type="date"
                      aria-label="Invoice date"
                      value={doc.date}
                      onChange={(e) => update("date", e.target.value)}
                    />
                  </Field>
                  <Field label={label("paymentTerms")}>
                    <input
                      aria-label="Payment terms"
                      value={doc.paymentTerms}
                      onChange={(e) => update("paymentTerms", e.target.value)}
                    />
                  </Field>
                  <Field label={label("dueDate")}>
                    <input
                      type="date"
                      aria-label="Due date"
                      value={doc.dueDate}
                      onChange={(e) => update("dueDate", e.target.value)}
                    />
                  </Field>
                  <Field label={label("poNumber")}>
                    <input
                      aria-label="PO number"
                      value={doc.poNumber}
                      onChange={(e) => update("poNumber", e.target.value)}
                    />
                  </Field>
                </div>
              </div>
              <div className="line-items">
                <div className="line-head">
                  <span>{label("item")}</span>
                  <span>{label("quantity")}</span>
                  <span>{label("rate")}</span>
                  <span>{label("amount")}</span>
                  <span />
                </div>
                {doc.items.map((item, i) => (
                  <div className="line-item" key={i}>
                    <AutoTextarea
                      aria-label={`Item ${i + 1} description`}
                      value={item.description}
                      rows={1}
                      placeholder="Description of item/service..."
                      onChange={(e) =>
                        update(
                          "items",
                          doc.items.map((x, j) =>
                            i === j ? { ...x, description: e.target.value } : x,
                          ),
                        )
                      }
                    />
                    <input
                      inputMode="decimal"
                      aria-label={`Item ${i + 1} quantity`}
                      value={item.quantity}
                      onChange={(e) =>
                        update(
                          "items",
                          doc.items.map((x, j) =>
                            i === j ? { ...x, quantity: e.target.value } : x,
                          ),
                        )
                      }
                    />
                    <div className="money-input">
                      <span aria-hidden="true">{currencySymbol}</span>
                      <input
                        inputMode="decimal"
                        aria-label={`Item ${i + 1} rate`}
                        value={item.rate}
                        onChange={(e) =>
                          update(
                            "items",
                            doc.items.map((x, j) =>
                              i === j ? { ...x, rate: e.target.value } : x,
                            ),
                          )
                        }
                      />
                    </div>
                    <span className="line-amount">
                      {totals ? format(totals.lines[i]) : "—"}
                    </span>
                    <button
                      className="icon-button"
                      aria-label={`Remove item ${i + 1}`}
                      disabled={doc.items.length === 1}
                      onClick={() =>
                        update(
                          "items",
                          doc.items.filter((_, j) => j !== i),
                        )
                      }
                    >
                      <Trash2 size={14} />
                    </button>
                  </div>
                ))}
                {doc.items.length < 200 && (
                  <button
                    className="text-button"
                    onClick={() =>
                      update("items", [
                        ...doc.items,
                        { description: "", quantity: "1", rate: "0" },
                      ])
                    }
                  >
                    <Plus size={15} /> Line Item
                  </button>
                )}
              </div>
              <div className="paper-bottom">
                <div className="paper-notes">
                  {doc.branding.showNotes && (
                    <Field label={label("notes")}>
                      <AutoTextarea
                        aria-label="Notes"
                        rows={2}
                        placeholder="Notes - any relevant information not already covered"
                        value={doc.notes}
                        onChange={(e) => update("notes", e.target.value)}
                      />
                    </Field>
                  )}
                  {doc.branding.showTerms && (
                    <Field label={label("terms")}>
                      <AutoTextarea
                        aria-label="Terms"
                        rows={2}
                        placeholder="Terms and conditions - late fees, payment methods, delivery schedule"
                        value={doc.terms}
                        onChange={(e) => update("terms", e.target.value)}
                      />
                    </Field>
                  )}
                </div>
                <div className="totals-editor">
                  <div className="total-row">
                    <span>{label("subtotal")}</span>
                    <strong>{totals ? format(totals.subtotal) : "—"}</strong>
                  </div>
                  <div className="invoice-adjustments">
                    {(["discount", "tax"] as const)
                      .filter(
                        (key) =>
                          key === "tax" ||
                          showDiscount ||
                          Number(doc.discount.value),
                      )
                      .map((key) => (
                        <div className="adjustment-row" key={key}>
                          <span>{label(key)}</span>
                          <div>
                            <input
                              aria-label={labels[key]}
                              inputMode="decimal"
                              value={doc[key].value}
                              onChange={(e) =>
                                update(key, {
                                  ...doc[key],
                                  value: e.target.value,
                                })
                              }
                            />
                            <span
                              className="adjustment-unit"
                              aria-hidden="true"
                            >
                              {doc[key].type === "percent"
                                ? "%"
                                : currencySymbol}
                            </span>
                            <button
                              className="adjustment-toggle"
                              aria-label={`Switch ${labels[key]} to ${doc[key].type === "percent" ? "fixed amount" : "percentage"}`}
                              title={`Switch to ${doc[key].type === "percent" ? "fixed amount" : "percentage"}`}
                              onClick={() =>
                                update(key, {
                                  ...doc[key],
                                  type:
                                    doc[key].type === "percent"
                                      ? "fixed"
                                      : "percent",
                                })
                              }
                            >
                              <RefreshCw size={16} />
                            </button>
                          </div>
                        </div>
                      ))}
                    {(showShippingCharge || Number(doc.shipping) > 0) && (
                      <div className="adjustment-row">
                        <span>{label("shipping")}</span>
                        <input
                          inputMode="decimal"
                          aria-label="Shipping charge"
                          value={doc.shipping}
                          onChange={(e) => update("shipping", e.target.value)}
                        />
                      </div>
                    )}
                    <div className="adjustment-add">
                      {!showDiscount && !Number(doc.discount.value) && (
                        <button
                          className="text-button"
                          onClick={() => setShowDiscount(true)}
                        >
                          <Plus size={14} /> Discount
                        </button>
                      )}
                      {!showShippingCharge && !Number(doc.shipping) && (
                        <button
                          className="text-button"
                          onClick={() => setShowShippingCharge(true)}
                        >
                          <Plus size={14} /> Shipping
                        </button>
                      )}
                    </div>
                  </div>
                  <div className="total-row total-emphasis">
                    <span>{label("total")}</span>
                    <strong>{totals ? format(totals.total) : "—"}</strong>
                  </div>
                  <div className="adjustment-row">
                    <span>{label("amountPaid")}</span>
                    <div className="money-input">
                      <span aria-hidden="true">{currencySymbol}</span>
                      <input
                        inputMode="decimal"
                        aria-label="Amount paid"
                        value={doc.amountPaid}
                        onChange={(e) => update("amountPaid", e.target.value)}
                      />
                    </div>
                  </div>
                  <div className="total-row balance">
                    <span>{label("balanceDue")}</span>
                    <strong>{totals ? format(totals.balanceDue) : "—"}</strong>
                  </div>
                </div>
              </div>
              <div className="custom-fields">
                {doc.customFields.map((field, i) => (
                  <div className="custom-field" key={i}>
                    <input
                      placeholder="Label"
                      aria-label={`Custom field ${i + 1} label`}
                      value={field.label}
                      onChange={(e) =>
                        update(
                          "customFields",
                          doc.customFields.map((x, j) =>
                            j === i ? { ...x, label: e.target.value } : x,
                          ),
                        )
                      }
                    />
                    <input
                      placeholder="Value"
                      aria-label={`Custom field ${i + 1} value`}
                      value={field.value}
                      onChange={(e) =>
                        update(
                          "customFields",
                          doc.customFields.map((x, j) =>
                            j === i ? { ...x, value: e.target.value } : x,
                          ),
                        )
                      }
                    />
                    <button
                      className="icon-button"
                      aria-label={`Remove custom field ${i + 1}`}
                      onClick={() =>
                        update(
                          "customFields",
                          doc.customFields.filter((_, j) => j !== i),
                        )
                      }
                    >
                      <Trash2 size={14} />
                    </button>
                  </div>
                ))}
                {doc.customFields.length < 20 && (
                  <button
                    className="text-button"
                    onClick={() =>
                      update("customFields", [
                        ...doc.customFields,
                        { label: "", value: "" },
                      ])
                    }
                  >
                    <Plus size={14} /> Add custom field
                  </button>
                )}
              </div>
            </fieldset>
          )}
          {calculationError && (
            <div className="inline-error" role="alert">
              {calculationError}
            </div>
          )}
        </div>
        <aside className="editor-aside" aria-label="Invoice controls">
          <div className="editor-status">
            {dirty ? (
              <span role="status">Unsaved changes</span>
            ) : (
              <span>Status</span>
            )}{" "}
            <strong className={`badge ${saved?.status || "draft"}`}>
              {saved?.archivedAt ? "Archived" : saved?.status || "Draft"}
            </strong>
          </div>
          <div className="heading-actions">
            <button className="button" onClick={() => setPreview(!preview)}>
              <span>{preview ? <Pencil size={16} /> : <Eye size={16} />}</span>
              {preview ? "Edit invoice" : "Preview PDF"}
            </button>
            <button
              className="button"
              disabled={busy || !!calculationError}
              onClick={() =>
                void run(async () => {
                  downloadBytes(
                    await makePdf(doc, saved?.status),
                    `${doc.invoiceNumber || "invoice"}.pdf`,
                  );
                })
              }
            >
              <Download size={16} /> Download
            </button>
            {editable && (
              <button
                className="button primary"
                disabled={busy || !!calculationError}
                onClick={() => void save()}
              >
                <Save size={16} />
                {busy ? "Saving…" : "Save draft"}
              </button>
            )}
          </div>
          <div className="panel actions-panel">
            <h2>
              {saved?.archivedAt
                ? "Archived invoice"
                : editable
                  ? "Issue invoice"
                  : "Invoice actions"}
            </h2>
            {editable ? (
              <>
                <p>
                  Issuing assigns a number and preserves this invoice’s details.
                </p>
                <button
                  className="button primary full"
                  disabled={busy || !!calculationError}
                  onClick={() => setConfirmIssue(true)}
                >
                  <Check size={16} /> Issue invoice
                </button>
              </>
            ) : (
              <>
                <p>
                  {saved?.archivedAt
                    ? "Restore it to make it available again."
                    : "Download the invoice, record a payment, or create a new draft from it."}
                </p>
                {saved?.archivedAt ? (
                  <button
                    className="button full"
                    disabled={busy}
                    onClick={() => void action("restore")}
                  >
                    <RotateCcw size={16} /> Restore invoice
                  </button>
                ) : (
                  <>
                    {saved?.status !== "void" && (
                      <button
                        className="button full"
                        disabled={busy}
                        onClick={() => {
                          setPaidValue(doc.amountPaid);
                          setPayment(true);
                        }}
                      >
                        <Check size={16} /> Record payment
                      </button>
                    )}
                  </>
                )}
              </>
            )}
            {saved && (
              <>
                <button
                  className="button full"
                  disabled={busy}
                  onClick={() => {
                    if (
                      !dirty ||
                      window.confirm(
                        "Duplicate the last saved version and leave this draft?",
                      )
                    )
                      void action("duplicate");
                  }}
                >
                  <Copy size={16} /> Duplicate as draft
                </button>
                {!saved.archivedAt && (
                  <>
                    <button
                      className="button full subtle"
                      disabled={busy}
                      onClick={() => {
                        if (
                          !dirty ||
                          window.confirm(
                            "Archive this invoice without saving your changes?",
                          )
                        )
                          void action("archive");
                      }}
                    >
                      <Archive size={16} /> Archive invoice
                    </button>
                    {saved.status !== "draft" && saved.status !== "void" && (
                      <button
                        className="text-button danger"
                        disabled={busy}
                        onClick={() => {
                          if (
                            window.confirm(
                              "Void this invoice? Its details will be preserved.",
                            )
                          )
                            void action("void");
                        }}
                      >
                        <Ban size={15} /> Void invoice
                      </button>
                    )}
                  </>
                )}
              </>
            )}
          </div>
          <fieldset
            disabled={!editable || busy}
            className="editor-options unstyled-fieldset"
          >
            <Field label="Currency">
              <select
                value={doc.currency}
                onChange={(e) => update("currency", e.target.value)}
              >
                {currencies.map((c) => (
                  <option key={c}>{c}</option>
                ))}
              </select>
            </Field>
            <details className="appearance-disclosure">
              <summary>Appearance</summary>
              <Field label="Branding preset">
                <select
                  value={presetId}
                  onChange={(e) => {
                    setPresetId(e.target.value);
                    const p = presets.find((p) => p.id === e.target.value);
                    if (p) update("branding", p.branding);
                  }}
                >
                  <option value="">Custom style</option>
                  {presets.map((p) => (
                    <option key={p.id} value={p.id}>
                      {p.name}
                    </option>
                  ))}
                </select>
              </Field>
              <BrandingFields
                includeLogo={false}
                value={doc.branding}
                onChange={(b) => {
                  setPresetId("");
                  update("branding", b);
                }}
                onError={(m) => notify(m, true)}
              />
              <Field label="Date & number format">
                <select
                  value={doc.locale}
                  onChange={(e) =>
                    update(
                      "locale",
                      e.target.value as InvoiceDocument["locale"],
                    )
                  }
                >
                  {[
                    "en-US",
                    "en-GB",
                    "en-CA",
                    "en-AU",
                    "de-DE",
                    "fr-FR",
                    "es-ES",
                    "it-IT",
                    "pt-PT",
                  ].map((l) => (
                    <option key={l}>{l}</option>
                  ))}
                </select>
              </Field>
            </details>
          </fieldset>
        </aside>
      </div>
      {confirmIssue && (
        <Modal
          title="Issue this invoice?"
          onClose={() => setConfirmIssue(false)}
        >
          <p>
            Issuing locks the billing details. You can then download the PDF or
            record a payment.
          </p>
          <div className="modal-actions">
            <button className="button" onClick={() => setConfirmIssue(false)}>
              Keep editing
            </button>
            <button
              className="button primary"
              onClick={() => {
                setConfirmIssue(false);
                void save(true);
              }}
            >
              Issue invoice
            </button>
          </div>
        </Modal>
      )}
      {payment && (
        <Modal title="Record a payment" onClose={() => setPayment(false)}>
          <p className="muted">
            Enter the total received so far. Total invoice:{" "}
            {format(saved!.totals.total)}.
          </p>
          <form
            onSubmit={(e) => {
              e.preventDefault();
              void action("payment", { amountPaid: paidValue }).then((ok) => {
                if (ok) setPayment(false);
              });
            }}
          >
            <Field label={`Amount paid (${doc.currency})`}>
              <input
                autoFocus
                inputMode="decimal"
                value={paidValue}
                onChange={(e) => setPaidValue(e.target.value)}
              />
            </Field>
            <div className="modal-actions">
              <button
                type="button"
                className="button"
                onClick={() => setPayment(false)}
              >
                Cancel
              </button>
              <button className="button primary" disabled={busy}>
                Save payment
              </button>
            </div>
          </form>
        </Modal>
      )}
    </>
  );
}
