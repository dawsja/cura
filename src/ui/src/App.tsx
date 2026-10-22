import { Routes, Route, Navigate } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { fetchMe } from './lib/auth';
import { ReviewsProvider } from './components/ReviewsProvider';
import { Setup } from './pages/Setup';
import { SignIn } from './pages/SignIn';
import { Layout } from './components/Layout';
import { Dashboard } from './pages/Dashboard';
import { Accounts } from './pages/Accounts';
import { Budget } from './pages/Budget';
import { Categories } from './pages/Categories';
import { Transactions } from './pages/Transactions';
import { Settings } from './pages/AdminSettings';
import { Paydown } from './pages/Paydown';
import { SaveUp } from './pages/SaveUp';
import { Reports } from './pages/Reports';
import { Rules } from './pages/Rules';
import { Recurring } from './pages/Recurring';
import { AsyncQueryState } from './components/ui/AsyncQueryState';
import { FinancialOnboardingProvider } from './components/FinancialOnboardingProvider';
import { CurrencyProvider } from './lib/currency';

interface SetupStatus {
  needsSetup: boolean;
  bootstrapCompleted: boolean;
  oidcConfigured: boolean;
  bootstrapTokenRequired: boolean;
  needsAdmin: boolean;
  demoMode: boolean;
}

async function fetchSetupStatus(): Promise<SetupStatus> {
  const r = await fetch('/api/setup/status', { credentials: 'include' });
  if (!r.ok) throw new Error('failed to fetch setup status');
  return r.json();
}

export default function App() {
  const setupQ = useQuery({ queryKey: ['setup'], queryFn: fetchSetupStatus });
  const meQ = useQuery({
    queryKey: ['me'],
    queryFn: fetchMe,
    enabled: setupQ.data?.bootstrapCompleted === true,
    refetchInterval: setupQ.data?.demoMode ? 5_000 : false,
  });

  // Block everything until we know the setup state.
  if (setupQ.isLoading) {
    return (
      <main className="flex h-full items-center justify-center bg-page p-4">
        <AsyncQueryState status="loading" title="Loading Cura Money…" message="Checking application setup." className="w-full max-w-sm" />
      </main>
    );
  }

  if (setupQ.isError) {
    return (
      <main className="flex h-full items-center justify-center bg-page p-4">
        <AsyncQueryState
          status="error"
          title="Could not start Cura Money"
          message="The application setup status could not be loaded. Check your connection and try again."
          onRetry={() => void setupQ.refetch()}
          retrying={setupQ.isFetching}
          className="w-full max-w-sm"
        />
      </main>
    );
  }

  if (setupQ.data?.needsSetup) {
    return (
      <Routes>
        <Route path="/setup" element={<Setup />} />
        {!setupQ.data.needsAdmin && <Route path="/sign-in" element={<SignIn />} />}
        <Route path="*" element={<Navigate to="/setup" replace />} />
      </Routes>
    );
  }

  // Setup done — require auth.
  if (meQ.isLoading) {
    return (
      <main className="flex h-full items-center justify-center bg-page p-4">
        <AsyncQueryState status="loading" title="Loading your account…" message="Checking your sign-in session." className="w-full max-w-sm" />
      </main>
    );
  }
  if (meQ.isError) {
    return (
      <main className="flex h-full items-center justify-center bg-page p-4">
        <AsyncQueryState
          status="error"
          title="Could not load your account"
          message="Your sign-in session could not be checked. Check your connection and try again."
          onRetry={() => void meQ.refetch()}
          retrying={meQ.isFetching}
          className="w-full max-w-sm"
        />
      </main>
    );
  }
  if (!meQ.data) {
    return (
      <Routes>
        <Route path="/sign-in" element={<SignIn />} />
        <Route path="*" element={<Navigate to="/sign-in" replace />} />
      </Routes>
    );
  }

  return (
    <CurrencyProvider initialCurrency={meQ.data.preferences?.currency ?? 'USD'}>
    <ReviewsProvider>
      <FinancialOnboardingProvider userId={meQ.data.user.id}>
        <Layout>
          <Routes>
            <Route path="/" element={<Dashboard />} />
            <Route path="/accounts" element={<Accounts />} />
            <Route path="/budget" element={<Budget />} />
            <Route path="/categories" element={<Categories />} />
            <Route path="/transactions" element={<Transactions />} />
            <Route path="/paydown" element={<Paydown />} />
            <Route path="/saveup" element={<SaveUp />} />
            <Route path="/reports" element={<Reports />} />
            <Route path="/rules" element={<Rules />} />
            <Route path="/recurring" element={<Recurring />} />
            <Route path="/settings" element={<Settings />} />
            <Route path="*" element={<Navigate to="/" replace />} />
          </Routes>
        </Layout>
      </FinancialOnboardingProvider>
    </ReviewsProvider>
    </CurrencyProvider>
  );
}
