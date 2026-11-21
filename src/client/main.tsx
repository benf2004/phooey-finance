import React, { Suspense, lazy, useEffect, useMemo, useState, useSyncExternalStore } from "react";
import { createRoot } from "react-dom/client";
import {
  LayoutDashboard,
  BookOpen,
  ArrowLeftRight,
  Landmark,
  Tags,
  Calculator,
  Sun,
  Moon,
  Search,
  LogOut,
  Menu,
  User,
  ShieldCheck,
  CheckCircle2,
  ExternalLink,
} from "lucide-react";
import "./styles.css";
import "./workspace.css";
import { api, post } from "./api";
import { Button, Field, Loading, ErrorNotice } from "./ui";
import { WorkspaceContext } from "./context";
import { createAppearanceAutosave } from "./appearance-autosave";
import { AppearanceSaveStatus } from "./AppearanceSaveStatus";
import type { Account, Category } from "../shared/models";
import { defaultTransactionAppearance, type TransactionAppearance } from "../shared/transaction-appearance";
const Foundation = lazy(()=>import("./pages/Foundation"));
const Overview = lazy(() => import("./pages/Overview"));
const Transactions = lazy(() => import("./pages/Transactions"));
const Accounts = lazy(() => import("./pages/Accounts"));
const Categories = lazy(() => import("./pages/Categories"));
const Taxes = lazy(() => import("./pages/Taxes"));
const DashboardPreview = lazy(() => import("./pages/DashboardPreview"));
const Settings = lazy(() => import("./pages/Settings"));
const nav = [
  { path: "/", name: "Overview", icon: LayoutDashboard },
  { path: "/reports", name: "Reports", icon: BookOpen },
  { path: "/transactions", name: "Transactions", icon: ArrowLeftRight },
  { path: "/accounts", name: "Accounts", icon: Landmark },
  { path: "/categories", name: "Categories & rules", icon: Tags },
  { path: "/tags", name: "Tags", icon: Tags },
  { path: "/taxes", name: "Tax planner", icon: Calculator },
];
function Wordmark() {
  return <picture className="brand-lockup"><source media="(prefers-color-scheme: dark)" srcSet="/business/assets/wordmark-dark.svg"/><img src="/business/assets/wordmark.svg" alt="phooey! finance"/></picture>;
}
function Login({ onLogin }: { onLogin: () => void }) {
  const [mode, setMode] = useState<"key" | "password" | null>(null);
  useEffect(() => {
    api<{ mode: "key" | "password" }>("/login-method")
      .then(r => setMode(r.mode)).catch(() => setMode("password"));
  }, []);
  const [error, setError] = useState<string | null>(null),
    [busy, setBusy] = useState(false);
  return (
    <main className="login-page">
      <div className="login-form">
        <div className="login-box">
          <a className="wordmark" href="/">
            <Wordmark/>
          </a>
          <h2>Sign in</h2>
          <form
            onSubmit={async (e) => {
              e.preventDefault();
              setBusy(true);
              setError(null);
              const form = new FormData(e.currentTarget);
              try {
                await post("/login", {
                  username: form.get("username") ?? "",
                  password: form.get("password"),
                });
                onLogin();
              } catch (e) {
                setError((e as Error).message);
              } finally {
                setBusy(false);
              }
            }}
          >
            {mode === "password" && <Field label="Username">
              <input
                name="username"
                autoComplete="username"
                required
                autoFocus
              />
            </Field>}
            <Field label={mode === "key" ? "Admin key" : "Password"}>
              <input
                name="password"
                type="password"
                autoComplete="current-password"
                required
              />
            </Field>
            <ErrorNotice error={error} />
            <Button busy={busy} disabled={!mode} type="submit">
              Sign in
            </Button>
          </form>
        </div>
      </div>
    </main>
  );
}
function OAuthConsent() {
  const [data, setData] = useState<{
      name: string;
      scopes: string[];
      redirect: string;
    } | null>(null),
    [error, setError] = useState<string | null>(null),
    [busy, setBusy] = useState(false);
  useEffect(() => {
    api<typeof data>("/oauth/request" + location.search)
      .then(setData)
      .catch((e) => setError(e.message));
  }, []);
  async function decide(approved: boolean) {
    setBusy(true);
    try {
      const result = await post<{ redirect: string }>("/oauth/authorize", {
        query: location.search.slice(1),
        approved,
      });
      location.assign(result.redirect);
    } catch (e) {
      setError((e as Error).message);
      setBusy(false);
    }
  }
  return (
    <div className="consent panel">
      <ShieldCheck size={32} />
      <h1>Connect your assistant</h1>
      {data && (
        <>
          <p>
            <strong>{data.name}</strong> is requesting access to this workspace.
          </p>
          <ul>
            {data.scopes.map((s) => (
              <li key={s}>{s}</li>
            ))}
          </ul>
          <p className="muted">
            You can revoke access in Settings at any time.
          </p>
          <div className="actions">
            <Button
              variant="secondary"
              busy={busy}
              onClick={() => decide(false)}
            >
              Decline
            </Button>
            <Button busy={busy} onClick={() => decide(true)}>
              Authorize connection
            </Button>
          </div>
        </>
      )}
      <ErrorNotice error={error} />
    </div>
  );
}
function App() {
  const [session, setSession] = useState<{
      hosted?: boolean;
      keyAuth?: boolean;
      invoicerUrl?: string;
      username: string;
      displayName: string;
      transactionAppearance: TransactionAppearance;
      demo: boolean;
      sourceUrl: string;
    } | null>(null),
    [ready, setReady] = useState(false),
    [version, setVersion] = useState(0),
    [accounts, setAccounts] = useState<Account[]>([]),
    [categories, setCategories] = useState<Category[]>([]),
    [path, setPath] = useState(location.pathname + location.search),
    [toast, setToast] = useState(""),
    [mobile, setMobile] = useState(false),
    [sidebarCollapsed, setSidebarCollapsed] = useState(() => {
      try {
        return localStorage.getItem("phooey-sidebar-collapsed") === "true";
      } catch {
        return false;
      }
    }),
    [theme, setTheme] = useState<"light" | "dark">(() => {
      const saved = localStorage.getItem("phooey-theme");
      return saved === "light" || saved === "dark" ? saved
        : matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";
    });
  const refresh = () => setVersion((v) => v + 1);
  const appearanceAutosave = useMemo(() => createAppearanceAutosave(
    (appearance) => post("/settings/transaction-appearance", appearance),
    (appearance) => setSession((current) => current ? { ...current, transactionAppearance: appearance } : current),
  ), [session?.username]);
  const appearanceSaveState = useSyncExternalStore(appearanceAutosave.subscribe, appearanceAutosave.getSnapshot);
  useEffect(() => {
    appearanceAutosave.activate();
    return () => appearanceAutosave.dispose();
  }, [appearanceAutosave]);
  const navigate = (next: string) => {
    history.pushState({}, "", next);
    setPath(next);
    setMobile(false);
    window.scrollTo({ top: 0 });
  };
  const loadSession = () =>
    api<typeof session>("/session")
      .then(setSession)
      .catch(() => setSession(null))
      .finally(() => setReady(true));
  useEffect(() => {
    void loadSession();
    const fn = () => setPath(location.pathname + location.search);
    addEventListener("popstate", fn);
    return () => removeEventListener("popstate", fn);
  }, []);
  useEffect(() => {
    document.documentElement.dataset.theme = theme;
    localStorage.setItem("phooey-theme", theme);
  }, [theme]);
  useEffect(() => {
    try {
      localStorage.setItem("phooey-sidebar-collapsed", String(sidebarCollapsed));
    } catch {
      // Keep the toggle usable when browser storage is unavailable.
    }
  }, [sidebarCollapsed]);
  useEffect(() => {
    if (session)
      Promise.all([api<Account[]>("/accounts"), api<Category[]>("/categories")])
        .then(([a, c]) => {
          setAccounts(a);
          setCategories(c);
        })
        .catch((e) => setToast(e.message));
  }, [session, version]);
  useEffect(() => {
    if (toast) {
      const t = setTimeout(() => setToast(""), 5000);
      return () => clearTimeout(t);
    }
  }, [toast]);
  useEffect(() => {
    const key = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key === "k") {
        e.preventDefault();
        navigate("/transactions?focus=search");
      }
    };
    addEventListener("keydown", key);
    return () => removeEventListener("keydown", key);
  }, []);
  if (!ready) return <Loading />;
  if (!session) return <Login onLogin={() => void loadSession()} />;
  const accountName = session.displayName || session.username;
  const requestedPath = path.split("?")[0];
  const active = ["/overview", "/dashboard"].includes(requestedPath) ? "/" : requestedPath === "/foundation" ? "/reports" : requestedPath;
  const menu = nav;
  const appearanceTabActive = (active === "/settings" || active === "/connections") &&
    new URLSearchParams(location.search).get("tab") === "appearance";
  const title = menu.find((n) => n.path === active)?.name ?? "Settings";
  const Page =
    active === "/reports" ? Foundation : (active === "/transactions" || active === "/tags")
      ? Transactions
      : active === "/accounts"
        ? Accounts
        : active === "/categories"
          ? Categories
          : active === "/taxes"
            ? Taxes
            : active === "/settings" || active === "/connections"
              ? Settings
              : Overview;
  const workspaceTools = (<div className="topbar-actions">
              {session.demo && <span className="badge amber">Demo data</span>}
              <button
                className="search-trigger"
                onClick={() => navigate("/transactions?focus=search")}
              >
                <Search size={16} />
                <span>Search transactions</span>
                <kbd>⌘ K</kbd>
              </button>
              <button
                className="icon-button"
                aria-label={
                  theme === "light" ? "Use dark theme" : "Use light theme"
                }
                onClick={() => setTheme(theme === "light" ? "dark" : "light")}
              >
                {theme === "light" ? <Moon size={18} /> : <Sun size={18} />}
              </button>
            </div>);
  return (
    <WorkspaceContext
      value={{
        hosted: session.hosted,
        keyAuth: session.keyAuth,
        accounts,
        categories,
        version,
        refresh,
        navigate,
        notify: setToast,
        demo: session.demo,
        sourceUrl: session.sourceUrl,
        username: session.username,
        displayName: session.displayName ?? "",
        updateProfile: (profile) =>
          setSession((current) => current ? { ...current, ...profile } : current),
        transactionAppearance: session.transactionAppearance ?? defaultTransactionAppearance,
        updateTransactionAppearance: appearanceAutosave.change,
        appearanceSaveState,
        retryTransactionAppearance: appearanceAutosave.retry,
        theme,
        setTheme,
      }}
    >
      {<div className={`app ${Page === Overview ? "overview-shell" : ""} ${sidebarCollapsed ? "sidebar-collapsed" : ""}`}>
        <aside id="app-sidebar" className={`sidebar ${mobile ? "open" : ""}`}>
          <div className="sidebar-header">
            <a
              className="wordmark"
              href="/"
              aria-label="phooey! finance home"
              title="phooey! finance home"
              onClick={(e) => {
                e.preventDefault();
                navigate("/");
              }}
            >
              <Wordmark/>
            </a>
            <button
              type="button"
              className="icon-button sidebar-toggle"
              aria-label={sidebarCollapsed ? "Expand sidebar" : "Collapse sidebar"}
              title={sidebarCollapsed ? "Expand sidebar" : "Collapse sidebar"}
              aria-controls="app-sidebar"
              aria-expanded={!sidebarCollapsed}
              onClick={() => setSidebarCollapsed((collapsed) => !collapsed)}
            >
              <Menu size={20} aria-hidden="true" />
            </button>
          </div>
          <nav aria-label="Main navigation">
            {menu.map((n) => (
              <a
                key={n.path}
                className={active === n.path ? "active" : ""}
                href={n.path}
                aria-label={n.name}
                aria-current={active === n.path ? "page" : undefined}
                title={n.name}
                onClick={(e) => {
                  e.preventDefault();
                  navigate(n.path);
                }}
              >
                <n.icon size={18} strokeWidth={1.6} aria-hidden="true" />
                <span className="nav-label">{n.name}</span>
              </a>
            ))}
            {session.invoicerUrl && <a href={session.invoicerUrl} title="Invoicer"><BookOpen size={18}/><span className="nav-label">Invoicer</span></a>}
          </nav>
          <div className="sidebar-bottom">
            {Page === Overview && <div className="sidebar-tools">{workspaceTools}</div>}
            <div className="profile">
              <a
                className="account-settings"
                href="/settings"
                aria-label={`${accountName} account settings`}
                title={`${accountName} account settings`}
                aria-current={
                  active === "/settings" || active === "/connections"
                    ? "page"
                    : undefined
                }
                onClick={(e) => {
                  if (e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey)
                    return;
                  e.preventDefault();
                  navigate("/settings");
                }}
              >
                <span className="avatar small" aria-hidden="true">
                  <User size={18} strokeWidth={1.6} />
                </span>
                <span className="account-name">
                  {accountName}
                  <small>Account settings</small>
                </span>
              </a>
              <button
                className="icon-button"
                aria-label="Sign out"
                title="Sign out"
                onClick={async () => {
                  await post("/logout", {});
                  if (session.hosted) location.assign("/");
                  setSession(null);
                }}
              >
                <LogOut size={16} />
              </button>
            </div>
          </div>
        </aside>
        <div className="main">
          <header className="topbar">
            <button
              className="icon-button mobile-toggle"
              aria-label="Toggle navigation"
              aria-controls="app-sidebar"
              aria-expanded={mobile}
              onClick={() => setMobile(!mobile)}
            >
              <Menu size={21} />
            </button>
            <div className="breadcrumb">
              <strong>{title}</strong>
            </div>
            {workspaceTools}
          </header>
          <main className="content">
            {!appearanceTabActive && appearanceSaveState.status === "error" && <AppearanceSaveStatus />}
            <Suspense fallback={<Loading />}>
              {active === "/oauth/authorize" ? (
                <OAuthConsent />
              ) : (
                <Page key={active} />
              )}
            </Suspense>
            <footer className="app-footer">
              <a href="/source.tar.gz">
                Source · AGPL-3.0 <ExternalLink size={11} />
              </a>
            </footer>
          </main>
        </div>
      </div>
      }
      {toast && (
        <div className="toast" role="status">
          <CheckCircle2 size={18} />
          {toast}
          <button
            onClick={() => setToast("")}
            aria-label="Dismiss notification"
          >
            ×
          </button>
        </div>
      )}
    </WorkspaceContext>
  );
}
createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    {location.pathname.replace(/\/$/, "") === "/dashboard-preview" ? <Suspense fallback={<Loading/>}><DashboardPreview/></Suspense> : <App />}
  </React.StrictMode>,
);
