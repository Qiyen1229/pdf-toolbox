import { Suspense, lazy } from 'react';
import { Navigate, Route, Routes, useLocation } from 'react-router-dom';
import { Layout } from './components/Layout';
import { useAuth } from './lib/auth';
import Home from './pages/Home';
import ToolPage from './pages/ToolPage';
import { Login, Register, Forgot, ResetPassword, VerifyEmail } from './pages/AuthPages';
import { Spinner } from './components/common';

const Viewer = lazy(() => import('./pages/Viewer'));
const Settings = lazy(() => import('./pages/Settings'));
const Admin = lazy(() => import('./pages/Admin'));

const Fallback = () => <div className="flex justify-center p-12"><Spinner /></div>;

export function App() {
  const loc = useLocation();
  return (
    <Layout>
      <Suspense fallback={<Fallback />}>
        <div key={loc.pathname} className="animate-page">
        <Routes location={loc}>
          <Route>
            <Route path="/" element={<Home />} />
            <Route path="/tool/:id" element={<ToolPage />} />
            <Route path="/viewer" element={<Viewer />} />
            <Route path="/settings" element={<Settings />} />
            <Route path="/admin/*" element={<Admin />} />
          </Route>
          <Route path="/login" element={<Login />} />
          <Route path="/register" element={<Register />} />
          <Route path="/forgot-password" element={<Forgot />} />
          <Route path="/reset-password" element={<ResetPassword />} />
          <Route path="/verify-email" element={<VerifyEmail />} />
          <Route path="*" element={<Navigate to="/" replace />} />
        </Routes>
        </div>
      </Suspense>
    </Layout>
  );
}
