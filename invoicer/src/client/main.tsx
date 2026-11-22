import { invoicePath, currentPath, bundled, financeUrl } from "./paths";
import { StrictMode, useEffect, useRef, useState, lazy, Suspense } from "react";
import { createRoot } from "react-dom/client";
import {
  FileText,
  Users,
  Palette,
  Settings,
  Code2,
  LogOut,
  ArrowRight,
  ChevronRight,
  Check,
  X,
  Menu,
  LockKeyhole,
  ShieldCheck,
  Plus,
} from "lucide-react";
import { api, body, setCsrf, setBusiness } from "./api";
import { Editor } from "./editor";
import { ApiPage, Customers, Invoices, Presets, SettingsPage } from "./pages";
import "./styles.css";
import "./workspace.css";

const SharedInvoice = lazy(() => import("./shared-invoice"));
function App() {
  const [authenticated, setAuthenticated] = useState(false);
  const [businesses, setBusinesses] = useState<{id: string; name: string}[]>([]);
  const [businessId, setBusinessId] = useState(localStorage.getItem("invoicer-business") || "default");
  const [businessName, setBusinessName] = useState("");
  const [addingBusiness, setAddingBusiness] = useState(false);
  const [businessBusy, setBusinessBusy] = useState(false);
  useEffect(() => {
    if (!authenticated) return;
    const refresh = () => api<{items: {id: string; name: string}[]}>("/businesses").then(r => {
      setBusinesses(r.items);
      if (!r.items.some(b => b.id === (localStorage.getItem("invoicer-business") || "default"))) { setBusinessId("default"); setBusiness("default"); }
    }).catch(e => notify(e.message, true));
    void refresh();
    window.addEventListener("business-updated", refresh);
    return () => window.removeEventListener("business-updated", refresh);
  }, [authenticated]);
  const [checking, setChecking] = useState(true);
  const [path, setPath] = useState(currentPath());
  const draftDirty = useRef(false);
  const acceptedPath = useRef(currentPath());
  const entry = useRef<number>(history.state?.invoiceEntry ?? 0);
  function canLeaveDraft() {
    return (
      !draftDirty.current ||
      window.confirm("Leave this invoice? Unsaved changes will be lost.")
    );
  }
  const [mobileMenu, setMobileMenu] = useState(false);
  const [toast, setToast] = useState<{ message: string; error: boolean }>();
  const notify = (message: string, error = false) =>
    setToast({ message, error });
  useEffect(() => {
    const timer = toast
      ? setTimeout(() => setToast(undefined), toast.error ? 12000 : 5000)
      : undefined;
    return () => clearTimeout(timer);
  }, [toast]);
  useEffect(() => {
    if (currentPath().startsWith("/s/")) {
      setChecking(false);
      return;
    }
    history.replaceState({ ...history.state, invoiceEntry: entry.current }, "");
    api<{ csrfToken: string }>("/auth/session")
      .then((r) => {
        setCsrf(r.csrfToken);
        setAuthenticated(true);
      })
      .catch(() => {})
      .finally(() => setChecking(false));
    const pop = (event: PopStateEvent) => {
      const next = currentPath();
      const nextEntry = event.state?.invoiceEntry;
      if (next === acceptedPath.current) {
        if (typeof nextEntry === "number") entry.current = nextEntry;
        return;
      }
      if (!canLeaveDraft()) {
        if (typeof nextEntry === "number" && nextEntry !== entry.current) {
          history.go(entry.current - nextEntry);
        } else {
          history.pushState(
            { invoiceEntry: entry.current },
            "",
            invoicePath(acceptedPath.current),
          );
        }
        return;
      }
      entry.current = nextEntry ?? entry.current;
      acceptedPath.current = next;
      setPath(next);
      setMobileMenu(false);
    };
    const expire = () => {
      if (bundled) {
        location.assign("/");
        return;
      }
      setAuthenticated(false);
      setCsrf("");
      notify("Your session expired. Sign in again.", true);
    };
    window.addEventListener("popstate", pop);
    window.addEventListener("session-expired", expire);
    return () => {
      window.removeEventListener("popstate", pop);
      window.removeEventListener("session-expired", expire);
    };
  }, []);
  function navigate(next: string) {
    acceptedPath.current = next;
    entry.current += 1;
    history.pushState({ invoiceEntry: entry.current }, "", invoicePath(next));
    setPath(next);
    setMobileMenu(false);
    window.scrollTo(0, 0);
  }
  const nav = [
    { path: "/", label: "Invoices", icon: FileText },
    { path: "/customers", label: "Customers", icon: Users },
    { path: "/presets", label: "Branding presets", icon: Palette },
    { path: "/settings", label: "Business settings", icon: Settings },
    { path: "/api", label: "API & MCP", icon: Code2 },
  ];
  const current = path === "/new" || path.startsWith("/invoices/") ? "/" : path;
  return (
    <>
      {path.startsWith("/s/") ? (
        <Suspense
          fallback={<div className="loading-state">Opening invoice…</div>}
        >
          <SharedInvoice token={path.split("/")[2]} />
        </Suspense>
      ) : checking ? (
        <div className="app-loading">
          <span className="brand-mark">
            <FileText size={22} />
          </span>
          Getting things ready…
        </div>
      ) : !authenticated ? (
        <Login
          onLogin={(csrf) => {
            setCsrf(csrf);
            setAuthenticated(true);
          }}
        />
      ) : (
        <div className="invoice-app">
          <header className="suite-nav">
            <a
              className="suite-brand"
              href={invoicePath("/")}
              onClick={(e) => {
                e.preventDefault();
                if (canLeaveDraft()) navigate("/");
              }}
            >
              <img src={invoicePath("/phooey-wordmark.svg")} alt="phooey!" />{" "}
              invoicer
            </a>
            <button
              className="suite-menu"
              aria-expanded={mobileMenu}
              aria-controls="invoice-nav"
              onClick={() => setMobileMenu(!mobileMenu)}
            >
              <Menu size={18} /> Menu
            </button>
            <div className="business-switcher"><label htmlFor="business-switch">Business</label><select id="business-switch" value={businessId} onChange={e => { if (!canLeaveDraft()) return; setBusiness(e.target.value); setBusinessId(e.target.value); navigate("/"); }}>{businesses.map(b => <option value={b.id} key={b.id}>{b.name}</option>)}</select><button className="text-button" onClick={() => setAddingBusiness(!addingBusiness)}><Plus size={14}/> Add business</button>{addingBusiness && <form onSubmit={async e => { e.preventDefault(); if (!canLeaveDraft()) return; setBusinessBusy(true); try { const b = await api<{id:string;name:string}>("/businesses", {method:"POST", body:body({name:businessName})}); setBusinesses(old => [...old,b]); setBusiness(b.id); setBusinessId(b.id); setAddingBusiness(false); setBusinessName(""); navigate("/settings"); } catch(e) { notify((e as Error).message,true); } finally { setBusinessBusy(false); } }}><input aria-label="New business name" placeholder="Business name" maxLength={200} required value={businessName} onChange={e => setBusinessName(e.target.value)}/><button className="button primary" disabled={businessBusy}>Create business</button></form>}</div>
            <nav
              id="invoice-nav"
              className={mobileMenu ? "open" : ""}
              aria-label="Workspace"
            >
              {financeUrl && <a href={financeUrl} onClick={e => { if (!canLeaveDraft()) e.preventDefault(); }}>Finance <ArrowRight size={15} /></a>}
              {nav.map((n) => (
                <a
                  key={n.path}
                  href={invoicePath(n.path)}
                  aria-current={current === n.path ? "page" : undefined}
                  onClick={(e) => {
                    if (e.metaKey || e.ctrlKey || e.shiftKey || e.altKey)
                      return;
                    e.preventDefault();
                    if (canLeaveDraft()) navigate(n.path);
                  }}
                >
                  <n.icon size={18} /> {n.label}
                </a>
              ))}
            </nav>
            <button
              className="logout"
              onClick={() => {
                if (!canLeaveDraft()) return;
                void api("/auth/logout", { method: "POST" })
                  .then(() => {
                    if (bundled) {
                      location.assign("/");
                      return;
                    }
                    setAuthenticated(false);
                    setCsrf("");
                  })
                  .catch((e) => notify(e.message, true));
              }}
            >
              <LogOut size={16} /> Sign out
            </button>
          </header>
          <div className="invoice-main">
            <main key={businessId + path}>
              {path === "/new" || path.startsWith("/invoices/") ? (
                <Editor
                  key={path}
                  id={
                    path.startsWith("/invoices/")
                      ? path.split("/")[2]
                      : undefined
                  }
                  navigate={navigate}
                  onDirtyChange={(dirty) => {
                    draftDirty.current = dirty;
                  }}
                  onDraftCreated={(next) => {
                    acceptedPath.current = next;
                    history.replaceState(history.state, "", invoicePath(next));
                  }}
                  notify={notify}
                />
              ) : path === "/customers" ? (
                <Customers navigate={navigate} notify={notify} />
              ) : path === "/presets" ? (
                <Presets navigate={navigate} notify={notify} />
              ) : path === "/settings" ? (
                <SettingsPage navigate={navigate} notify={notify} />
              ) : path === "/api" ? (
                <ApiPage notify={notify} />
              ) : (
                <Invoices navigate={navigate} notify={notify} />
              )}
            </main>
            <footer className="suite-footer">
              <a href="https://github.com/benf2004/phooey-finance" target="_blank" rel="noreferrer">GitHub · AGPL-3.0</a>
            </footer>
          </div>
        </div>
      )}
      {toast && (
        <div
          className={`toast ${toast.error ? "error" : ""}`}
          role={toast.error ? "alert" : "status"}
        >
          {toast.error ? <X size={18} /> : <Check size={18} />}
          <span>{toast.message}</span>
          <button
            aria-label="Dismiss notification"
            onClick={() => setToast(undefined)}
          >
            <X size={16} />
          </button>
        </div>
      )}
    </>
  );
}
function Login({ onLogin }: { onLogin: (csrf: string) => void }) {
  const [key, setKey] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  async function login(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError("");
    try {
      const r = await api<{ csrfToken: string }>("/auth/login", {
        method: "POST",
        body: body({ key }),
      });
      setKey("");
      onLogin(r.csrfToken);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  if (bundled) return <main className="invoice-login"><div className="login-form"><div className="login-wordmark"><img src={invoicePath('/phooey-wordmark.svg')} alt="phooey!"/> invoicer</div><h1>Sign in to Invoicer</h1><a className="button primary" href="/">Continue to sign in <ArrowRight size={17}/></a></div></main>;
  return (
    <main className="invoice-login">
      <form className="login-form" onSubmit={(e) => void login(e)}>
        <div className="login-wordmark">
          <img src={invoicePath("/phooey-wordmark.svg")} alt="phooey!" />{" "}
          invoicer
        </div>
        <h1>A little less paperwork.</h1>
        <p>Sign in to create invoices, follow up on payments, and keep your business moving.</p>
        <label className="field">
          <span>Admin key</span>
          <input
            type="password"
            required
            autoComplete="current-password"
            value={key}
            onChange={(e) => setKey(e.target.value)}
          />
        </label>
        {error && (
          <div className="inline-error" role="alert">
            {error}
          </div>
        )}
        <button className="button primary full" disabled={busy}>
          {busy ? "Signing in…" : "Sign in"}
          <ArrowRight size={17} />
        </button>
        <a href="https://github.com/benf2004/phooey-finance" target="_blank" rel="noreferrer">View source on GitHub</a>
      </form>
    </main>
  );
}
createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
