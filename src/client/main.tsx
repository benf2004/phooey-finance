import React, { Suspense, lazy, useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import {
  LayoutDashboard,
  ArrowLeftRight,
  Landmark,
  Tags,
  Calculator,
  Settings as SettingsIcon,
  Sun,
  Moon,
  Search,
  LogOut,
  Menu,
  ShieldCheck,
  CheckCircle2,
  ExternalLink,
} from "lucide-react";
import "./styles.css";
import { api, post } from "./api";
import { Button, Field, Loading, ErrorNotice } from "./ui";
import { WorkspaceContext } from "./context";
import type { Account, Category } from "../shared/models";
const Overview = lazy(() => import("./pages/Overview"));
const Transactions = lazy(() => import("./pages/Transactions"));
const Accounts = lazy(() => import("./pages/Accounts"));
const Categories = lazy(() => import("./pages/Categories"));
const Taxes = lazy(() => import("./pages/Taxes"));
const Settings = lazy(() => import("./pages/Settings"));
const nav = [
  { path: "/", name: "Overview", icon: LayoutDashboard },
  { path: "/transactions", name: "Transactions", icon: ArrowLeftRight },
  { path: "/accounts", name: "Accounts", icon: Landmark },
  { path: "/categories", name: "Categories & rules", icon: Tags },
  { path: "/taxes", name: "Tax planner", icon: Calculator },
];
function Login({ onLogin }: { onLogin: () => void }) {
  const [error, setError] = useState<string | null>(null),
    [busy, setBusy] = useState(false);
  return (
    <main className="login-page">
      <div className="login-form">
        <div className="login-box">
          <a className="wordmark" href="/">
            phooey<span>finance</span>
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
                  username: form.get("username"),
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
            <Field label="Username">
              <input
                name="username"
                autoComplete="username"
                required
                autoFocus
              />
            </Field>
            <Field label="Password">
              <input
                name="password"
                type="password"
                autoComplete="current-password"
                required
              />
            </Field>
            <ErrorNotice error={error} />
            <Button busy={busy} type="submit">
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
      username: string;
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
    [theme, setTheme] = useState(
      localStorage.getItem("phooey-theme") ??
        (matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light"),
    );
  const refresh = () => setVersion((v) => v + 1);
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
  const active = path.split("?")[0];
  const title = nav.find((n) => n.path === active)?.name ?? "Settings";
  const Page =
    active === "/transactions"
      ? Transactions
      : active === "/accounts"
        ? Accounts
        : active === "/categories"
          ? Categories
          : active === "/taxes"
            ? Taxes
            : active === "/settings"
              ? Settings
              : Overview;
  return (
    <WorkspaceContext
      value={{
        accounts,
        categories,
        version,
        refresh,
        navigate,
        notify: setToast,
        demo: session.demo,
        sourceUrl: session.sourceUrl,
      }}
    >
      <div className="app">
        <aside className={`sidebar ${mobile ? "open" : ""}`}>
          <a
            className="wordmark"
            href="/"
            onClick={(e) => {
              e.preventDefault();
              navigate("/");
            }}
          >
            phooey<span>finance</span>
          </a>
          <nav>
            {nav.map((n) => (
              <a
                key={n.path}
                className={active === n.path ? "active" : ""}
                href={n.path}
                onClick={(e) => {
                  e.preventDefault();
                  navigate(n.path);
                }}
              >
                <n.icon size={18} strokeWidth={1.6} />
                {n.name}
              </a>
            ))}
          </nav>
          <div className="sidebar-bottom">
            <a
              className={active === "/settings" ? "active" : ""}
              href="/settings"
              onClick={(e) => {
                e.preventDefault();
                navigate("/settings");
              }}
            >
              <SettingsIcon size={18} />
              Settings & connections
            </a>
            <div className="profile">
              <span className="avatar small">
                {session.username.slice(0, 1).toUpperCase()}
              </span>
              <div>
                {session.username}
                <small>Administrator</small>
              </div>
              <button
                className="icon-button"
                aria-label="Sign out"
                onClick={async () => {
                  await post("/logout", {});
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
              onClick={() => setMobile(!mobile)}
            >
              <Menu size={21} />
            </button>
            <div className="breadcrumb">
              <strong>{title}</strong>
            </div>
            <div className="topbar-actions">
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
            </div>
          </header>
          <main className="content">
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
    <App />
  </React.StrictMode>,
);
