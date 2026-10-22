import { useState, useEffect } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { signInEmail, fetchMe, SIGNOUT_FLAG_KEY } from '../lib/auth';
import { api } from '../lib/api';
import { AuthBrand, AuthError, AuthPage, AuthPanel, AuthTextField } from '../components/AuthScreen';
import { AsyncQueryState } from '../components/ui/AsyncQueryState';
import { Alert, AlertDescription, AlertTitle } from '../components/ui/alert';
import { Button } from '../components/ui/button';
import { FieldSeparator } from '../components/ui/field';
import { Spinner } from '../components/ui/spinner';

interface OidcProvider {
  providerId: string;
  displayName: string;
}

interface AuthOptions {
  localAuthDisabled: boolean;
  providers: OidcProvider[];
  demoMode: boolean;
  demoCredentials?: {
    email: string;
    password: string;
  };
}

export function SignIn() {
  const navigate = useNavigate();
  const [params] = useSearchParams();
  const qc = useQueryClient();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [oidcBusy, setOidcBusy] = useState<string | null>(null);
  // Read the "just signed out" flag from sessionStorage. When set, the
  // next OIDC click will include `prompt=login` so the IdP forces a
  // fresh login. We clear the flag on read so it only affects the
  // immediate post-signout attempt and not later visits to /sign-in.
  const [fromSignOut] = useState<boolean>(() => {
    const flag = sessionStorage.getItem(SIGNOUT_FLAG_KEY);
    if (flag) {
      sessionStorage.removeItem(SIGNOUT_FLAG_KEY);
      return true;
    }
    return false;
  });

  useEffect(() => {
    if (fromSignOut) {
      qc.invalidateQueries({ queryKey: ['me'] });
    }
  }, [fromSignOut, qc]);

  // Only same-origin paths: never follow `//host` or absolute URLs.
  const requestedCallback = params.get('callbackURL');
  const callbackURL = requestedCallback && /^\/(?![/\\])/.test(requestedCallback) ? requestedCallback : '/';

  // One fetch carries both the OIDC provider list AND the
  // `localAuthDisabled` flag so we can't render a half-applied view
  // (e.g. show the email form for one frame while it's about to be
  // hidden). See src/routes/auth.ts → /auth-options.
  const authOptions = useQuery({
    queryKey: ['auth-options'],
    queryFn: () => api.get<AuthOptions>('/api/auth-app/auth-options'),
  });

  useEffect(() => {
    const creds = authOptions.data?.demoCredentials;
    if (!authOptions.data?.demoMode || !creds) return;
    setEmail((current) => current || creds.email);
    setPassword((current) => current || creds.password);
  }, [authOptions.data]);

  const onSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setErr(null);
    setBusy(true);
    try {
      await signInEmail(email, password);
      await qc.invalidateQueries({ queryKey: ['me'] });
      const me = await fetchMe();
      if (!me) throw new Error('sign-in succeeded but no session found');
      navigate(callbackURL);
    } catch (e2) {
      setErr((e2 as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const startOidc = async (providerId: string) => {
    setErr(null);
    setOidcBusy(providerId);
    try {
      const body: Record<string, unknown> = { providerId, callbackURL };
      if (fromSignOut) {
        body.additionalData = { promptLogin: true };
      }
      const resp = await fetch('/api/auth/sign-in/oauth2', {
        method: 'POST',
        credentials: 'include',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      });
      if (!resp.ok) {
        const failed = await resp.json().catch(() => ({}));
        throw new Error(failed.error ?? `OIDC sign-in failed (${resp.status})`);
      }
      const data = (await resp.json()) as { url?: string; redirect?: boolean };
      if (data.url) {
        window.location.href = data.url;
      } else {
        throw new Error('OIDC provider did not return an authorization URL');
      }
    } catch (e) {
      setErr((e as Error).message);
      setOidcBusy(null);
    }
  };

  if (authOptions.isPending) {
    return (
      <AuthPage>
        <AuthPanel>
          <AuthBrand title="Cura Money" />
          <AsyncQueryState
            status="loading"
            title="Loading sign-in…"
            message="Checking how this instance is set up."
          />
        </AuthPanel>
      </AuthPage>
    );
  }

  if (authOptions.isError || !authOptions.data) {
    return (
      <AuthPage>
        <AuthPanel>
          <AuthBrand title="Cura Money" />
          <AsyncQueryState
            status="error"
            title="Could not load sign-in"
            message="Sign-in options could not be loaded. Check your connection and try again."
            onRetry={() => void authOptions.refetch()}
            retrying={authOptions.isFetching}
          />
        </AuthPanel>
      </AuthPage>
    );
  }

  const demoMode = authOptions.data.demoMode;
  const oidcList = authOptions.data.providers;
  const showLocalForm = !authOptions.data.localAuthDisabled;
  const lockedOut = !showLocalForm && oidcList.length === 0;

  let title = 'Sign in';
  let subtitle: string | undefined = 'Use your Cura Money account.';
  if (demoMode) {
    title = 'Try Cura Money';
    subtitle = undefined;
  } else if (showLocalForm && oidcList.length > 0) {
    subtitle = 'Use your email or identity provider.';
  } else if (!showLocalForm && oidcList.length > 0) {
    subtitle = 'Continue with your identity provider.';
  } else if (lockedOut) {
    subtitle = 'Sign-in is not available on this instance.';
  }

  return (
    <AuthPage>
      <AuthPanel>
        <AuthBrand title={title} subtitle={subtitle} />

        {showLocalForm && (
          <form onSubmit={onSubmit} className="flex flex-col gap-3">
            <AuthTextField
              label="Email"
              type="email"
              name="email"
              value={email}
              onChange={setEmail}
              autoComplete="username"
              disabled={busy}
            />
            <AuthTextField
              label="Password"
              type="password"
              name="password"
              value={password}
              onChange={setPassword}
              autoComplete="current-password"
              disabled={busy}
            />
            {err && <AuthError message={err} />}
            <Button type="submit" className="w-full" disabled={busy || !!oidcBusy}>
              {busy ? <Spinner data-icon="inline-start" /> : null}
              {busy ? (demoMode ? 'Entering…' : 'Signing in…') : demoMode ? 'Enter demo' : 'Sign in'}
            </Button>
          </form>
        )}

        {lockedOut && (
          <Alert>
            <AlertTitle>Local sign-in is disabled</AlertTitle>
            <AlertDescription>
              An admin has turned off email/password sign-in. Ask them to
              add an OIDC provider in Settings → Authentication, or to
              re-enable local sign-in.
            </AlertDescription>
          </Alert>
        )}

        {!showLocalForm && err && <AuthError message={err} />}

        {oidcList.length > 0 && (
          <div className={showLocalForm ? 'mt-4' : undefined}>
            {showLocalForm && <FieldSeparator>or</FieldSeparator>}
            <div className="flex flex-col gap-2">
              {oidcList.map((provider) => (
                <Button
                  key={provider.providerId}
                  type="button"
                  variant={showLocalForm ? 'outline' : 'default'}
                  className="w-full"
                  disabled={busy || !!oidcBusy}
                  onClick={() => void startOidc(provider.providerId)}
                >
                  {oidcBusy === provider.providerId ? <Spinner data-icon="inline-start" /> : null}
                  {oidcBusy === provider.providerId
                    ? `Continuing with ${provider.displayName}…`
                    : `Sign in with ${provider.displayName}`}
                </Button>
              ))}
            </div>
          </div>
        )}
      </AuthPanel>
    </AuthPage>
  );
}
