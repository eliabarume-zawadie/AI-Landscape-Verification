import "@fontsource-variable/bricolage-grotesque";
import "@fontsource/ibm-plex-sans/400.css";
import "@fontsource/ibm-plex-sans/500.css";
import "@fontsource/ibm-plex-sans/600.css";
import "@fontsource/ibm-plex-mono/400.css";
import "./styles/app.css";
import { StrictMode, useState, type FormEvent } from "react";
import { createRoot } from "react-dom/client";
import { BrowserRouter, Navigate, NavLink, Outlet, Route, Routes } from "react-router-dom";
import { AuthProvider, errorText, isLead, useAuth } from "./auth";
import { DashboardPage } from "./pages/Dashboard";
import { EvaluationPage } from "./pages/Evaluation";
import { EvaluationRunPage } from "./pages/EvaluationRun";
import { GoldenExamplePage } from "./pages/GoldenExample";
import { FastLanePage } from "./pages/FastLane";
import { FeedbackPage } from "./pages/Feedback";
import { KnowledgePage } from "./pages/Knowledge";
import { LocationDetailPage } from "./pages/LocationDetail";
import { QueuePage } from "./pages/Queue";
import { ReviewPage } from "./pages/Review";

function Login() {
  const { login } = useAuth();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await login(email, password);
    } catch (err) {
      setError(errorText(err));
    } finally {
      setBusy(false);
    }
  };
  return (
    <main className="login">
      <form onSubmit={submit}>
        <div className="brand">
          ALVIP<span>.</span>
        </div>
        <p className="muted" style={{ margin: 0 }}>
          Sign in to verify landscape service photos.
        </p>
        <div className="field">
          <label htmlFor="email">Email</label>
          <input id="email" type="email" autoComplete="username" value={email} onChange={(e) => setEmail(e.target.value)} required autoFocus />
        </div>
        <div className="field">
          <label htmlFor="password">Password</label>
          <input id="password" type="password" autoComplete="current-password" value={password} onChange={(e) => setPassword(e.target.value)} required />
        </div>
        {error && <p className="error">{error}</p>}
        <button className="btn primary" type="submit" disabled={busy}>
          {busy ? "Signing in…" : "Sign in"}
        </button>
      </form>
    </main>
  );
}

function Shell() {
  const { user, logout } = useAuth();
  return (
    <div className="shell">
      <header className="topnav">
        <NavLink to="/" className="brand">
          ALVIP<span>.</span>
        </NavLink>
        <nav aria-label="Main">
          <NavLink to="/" end>
            Queue
          </NavLink>
          <NavLink to="/fast-lane">Fast lane</NavLink>
          <NavLink to="/knowledge">Team knowledge</NavLink>
          {isLead(user) && <NavLink to="/dashboard">Dashboard</NavLink>}
          {isLead(user) && <NavLink to="/feedback">Feedback</NavLink>}
          {isLead(user) && <NavLink to="/evaluation">Evaluation</NavLink>}
        </nav>
        <div className="who">
          <span className="muted">
            {user!.displayName} · {user!.role.replace("_", " ").toLowerCase()}
          </span>
          <button className="btn quiet" onClick={logout}>
            Sign out
          </button>
        </div>
      </header>
      <Outlet />
    </div>
  );
}

function App() {
  const { user, loading } = useAuth();
  if (loading) return null;
  if (!user) return <Login />;
  return (
    <Routes>
      <Route element={<Shell />}>
        <Route index element={<QueuePage />} />
        <Route path="review/:id" element={<ReviewPage />} />
        <Route path="locations/:id" element={<LocationDetailPage />} />
        <Route path="fast-lane" element={<FastLanePage />} />
        <Route path="knowledge" element={<KnowledgePage />} />
        <Route path="dashboard" element={isLead(user) ? <DashboardPage /> : <Navigate to="/" replace />} />
        <Route path="evaluation" element={isLead(user) ? <EvaluationPage /> : <Navigate to="/" replace />} />
        <Route path="evaluation/runs/:id" element={isLead(user) ? <EvaluationRunPage /> : <Navigate to="/" replace />} />
        <Route path="evaluation/examples/:id" element={isLead(user) ? <GoldenExamplePage /> : <Navigate to="/" replace />} />
        <Route path="feedback" element={isLead(user) ? <FeedbackPage /> : <Navigate to="/" replace />} />
        <Route path="*" element={<Navigate to="/" replace />} />
      </Route>
    </Routes>
  );
}

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <AuthProvider>
      <BrowserRouter>
        <App />
      </BrowserRouter>
    </AuthProvider>
  </StrictMode>,
);
