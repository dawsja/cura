import { useId, useState, type FormEvent, type ReactNode } from 'react';
import { useQuery, useQueryClient, useMutation } from '@tanstack/react-query';
import { Plus, Trash2, Edit3, RefreshCw, ShieldCheck, AlertTriangle, Copy, Check, KeyRound, Lock, Users, Eye, EyeOff, KeySquare, ShieldAlert, ShieldOff, Shield, Container, Coins, Bot } from 'lucide-react';
import clsx from 'clsx';
import { api } from '../lib/api';
import { fetchMe, changePassword } from '../lib/auth';
import { Alert, AlertAction, AlertDescription, AlertTitle } from '../components/ui/alert';
import { Badge } from '../components/ui/badge';
import { ConfirmDialog } from '../components/ui/confirm-dialog';
import { Button } from '../components/ui/button';
import { Card, CardAction, CardContent, CardDescription, CardHeader, CardTitle } from '../components/ui/card';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '../components/ui/dialog';
import { Empty, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from '../components/ui/empty';
import { Field, FieldDescription, FieldGroup, FieldLabel } from '../components/ui/field';
import { Input } from '../components/ui/input';
import { InputGroup, InputGroupAddon, InputGroupButton, InputGroupInput } from '../components/ui/input-group';
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '../components/ui/select';
import { Spinner } from '../components/ui/spinner';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '../components/ui/tabs';
import { ToggleGroup, ToggleGroupItem } from '../components/ui/toggle-group';
import { SUPPORTED_CURRENCIES, useCurrency } from '../lib/currency';
import { formatMoney, timeAgo } from '../lib/format';
import type { ApiError } from '../lib/api';

interface OidcProvider {
  id: string;
  providerId: string;
  discoveryUrl: string;
  clientId: string;
  hasClientSecret: boolean;
  scopes: string[];
  isActive: boolean;
  createdAt: string;
  callbackUri: string;
}

interface DiscoveryResult {
  ok: boolean;
  discovery?: {
    authorizationEndpoint: string;
    tokenEndpoint: string;
    userinfoEndpoint?: string;
    jwksUri?: string;
  };
  error?: string;
  code?: string;
}

interface AdminUser {
  id: string;
  name: string;
  email: string;
  role: string | null;
  createdAt: string;
  hasCredential: boolean;
  providers: string;
  isProtected: boolean;
  protectionReason:
    | 'last_admin'
    | 'last_local_admin'
    | 'last_oidc_admin_when_local_disabled'
    | null;
}

function protectionTooltip(reason: AdminUser['protectionReason']): string {
  switch (reason) {
    case 'last_admin':
      return 'Only remaining admin — demote or delete would lock the instance. Promote another user first.';
    case 'last_local_admin':
      return 'Only local admin — demote or delete would remove the recovery path. Promote another user to admin first.';
    case 'last_oidc_admin_when_local_disabled':
      return 'Only OIDC admin and local auth is disabled — this is the only sign-in path. Promote another OIDC user to admin first.';
    default:
      return 'Protected admin';
  }
}

interface LocalAuthInfo {
  localAuthDisabled: boolean;
  /** True when at least one OIDC provider is configured AND at least
   *  one user with role='admin' has signed in via a non-credential
   *  provider. When false, the "Disable local auth" button is locked
   *  and we surface a message explaining what the admin needs to do
   *  first. */
  canDisable: boolean;
  oidcAdminCount: number;
}

interface AuthOptions {
  localAuthDisabled: boolean;
  demoMode: boolean;
}

interface ContainerUpdateStatus {
  updateAvailable: boolean | null;
  currentRevision: string | null;
  latestRevision: string | null;
  checkedAt: string;
  reason?: 'build_revision_unavailable' | 'registry_unavailable';
}

const EMPTY_PROVIDER_FORM = {
  providerId: '',
  discoveryUrl: '',
  clientId: '',
  clientSecret: '',
  scopes: 'openid,email,profile',
};

export function Settings() {
  const me = useQuery({ queryKey: ['me'], queryFn: fetchMe });
  const [tab, setTab] = useState<'personal' | 'admin'>('personal');

  const isAdmin = me.data?.user.role === 'admin';

  if (me.isLoading) {
    return (
      <div className="flex items-center gap-2 text-muted-foreground">
        <Spinner />
        Loading…
      </div>
    );
  }
  if (me.isError) {
    return (
      <Alert variant="destructive" className="max-w-md">
        <AlertTriangle />
        <AlertTitle>Could not load settings</AlertTitle>
        <AlertDescription>Your current permissions could not be verified.</AlertDescription>
        <AlertAction>
          <Button type="button" size="sm" variant="outline" onClick={() => void me.refetch()} disabled={me.isFetching}>
            {me.isFetching ? <Spinner data-icon="inline-start" /> : null}
            Retry
          </Button>
        </AlertAction>
      </Alert>
    );
  }

  const personal = (
    <div className="flex flex-col gap-4">
      <PreferencesSection />
      <McpAccessSection />
      <PasswordSection
        hasCredential={me.data?.user.hasCredential ?? false}
        email={me.data?.user.email ?? ''}
      />
    </div>
  );

  return (
    <div className="flex flex-col gap-6">
      <h1 className="text-2xl font-bold">Settings</h1>

      {isAdmin ? (
        <Tabs
          value={tab}
          onValueChange={(value) => {
            if (value === 'personal' || value === 'admin') setTab(value);
          }}
        >
          <TabsList variant="line" aria-label="Settings sections">
            <TabsTrigger value="personal">Personal</TabsTrigger>
            <TabsTrigger value="admin">Admin</TabsTrigger>
          </TabsList>
          <TabsContent value="personal">{personal}</TabsContent>
          <TabsContent value="admin">
            <div className="flex flex-col gap-6">
              <ContainerUpdateSection />
              <OidcSection />
              <AuthenticationSection />
              <UsersSection />
            </div>
          </TabsContent>
        </Tabs>
      ) : (
        personal
      )}
    </div>
  );
}

function SectionIcon({ children, tone = 'default' }: { children: ReactNode; tone?: 'default' | 'rose' }) {
  return (
    <span
      className={clsx(
        'flex size-7 items-center justify-center rounded-lg',
        tone === 'rose' ? 'bg-destructive/10 text-destructive' : 'bg-primary/10 text-primary',
      )}
    >
      {children}
    </span>
  );
}

function ContainerUpdateSection() {
  const qc = useQueryClient();
  const status = useQuery({
    queryKey: ['admin', 'system', 'update'],
    queryFn: () => api.get<ContainerUpdateStatus>('/api/admin/system/update'),
    refetchInterval: 30 * 60 * 1000,
    refetchOnWindowFocus: true,
  });
  const refresh = useMutation({
    mutationFn: () => api.get<ContainerUpdateStatus>('/api/admin/system/update?refresh=true'),
    onSuccess: (data) => qc.setQueryData(['admin', 'system', 'update'], data),
  });
  const data = status.data;

  const checking = status.isFetching || refresh.isPending;
  const checkedAt = data?.checkedAt
    ? new Date(data.checkedAt).toLocaleString()
    : null;

  return (
    <Card className="max-w-lg">
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <SectionIcon><Container className="h-4 w-4" /></SectionIcon>
          Updates
        </CardTitle>
        <CardDescription>Checks the published latest image periodically.</CardDescription>
        <CardAction>
          <Button type="button" variant="outline" onClick={() => refresh.mutate()} disabled={checking}>
            {checking ? <Spinner data-icon="inline-start" /> : <RefreshCw data-icon="inline-start" />}
            {checking ? 'Checking…' : 'Check'}
          </Button>
        </CardAction>
      </CardHeader>
      <CardContent>
        {data?.updateAvailable ? (
          <Alert role="status">
            <AlertTriangle />
            <AlertTitle>A newer container image is available</AlertTitle>
            {checkedAt ? <AlertDescription>Checked {checkedAt}</AlertDescription> : null}
          </Alert>
        ) : (
          <div className="flex items-start gap-3 text-sm text-muted-foreground">
            {data?.updateAvailable === false ? (
              <Check className="mt-0.5 size-5 shrink-0 text-emerald-400" />
            ) : (
              <Container className="mt-0.5 size-5 shrink-0" />
            )}
            <div className="min-w-0">
              <p>
                {status.isLoading
                  ? 'Checking the published image…'
                  : status.isError
                    ? 'Could not check for container updates.'
                    : data?.updateAvailable === false
                      ? 'Up to date.'
                      : data?.reason === 'build_revision_unavailable'
                        ? checkedAt
                          ? `Checked ${checkedAt}`
                          : 'Not checked yet.'
                        : 'The image registry could not be checked right now.'}
              </p>
              {checkedAt && data?.reason !== 'build_revision_unavailable' && (
                <p className="mt-1 text-xs">Checked {checkedAt}</p>
              )}
            </div>
          </div>
        )}
      </CardContent>
    </Card>
  );
}

// ============================================================================
// OIDC providers — existing functionality, just lifted out of the old page.
// ============================================================================

function OidcSection() {
  const qc = useQueryClient();
  const providers = useQuery({
    queryKey: ['admin', 'oidc', 'providers'],
    queryFn: () => api.get<OidcProvider[]>('/api/admin/oidc/providers'),
  });
  const [editing, setEditing] = useState<OidcProvider | null>(null);
  const [adding, setAdding] = useState(false);
  // Shown after a save that the server reports needs a container restart
  // (i.e. the in-memory Better Auth instance couldn't be hot-reloaded —
  // which in v0.1 only happens if `refreshAuth()` is broken, so this
  // banner should be rare). When the server returns `restart_required:
  // false` we silently invalidate and continue — the new provider is
  // already live.
  const [needsRestart, setNeedsRestart] = useState(false);

  const del = useMutation({
    mutationFn: (id: string) => api.delete<{ restart_required: boolean }>(`/api/admin/oidc/providers/${id}`),
    onSuccess: (data) => {
      qc.invalidateQueries({ queryKey: ['admin', 'oidc'] });
      if (data?.restart_required) setNeedsRestart(true);
    },
  });

  return (
    <section className="flex flex-col gap-3">
      {needsRestart && (
        <Alert>
          <AlertTriangle />
          <AlertTitle>Restart required</AlertTitle>
          <AlertDescription>
            The provider list changed. Run{' '}
            <code className="rounded bg-muted px-1.5 py-0.5 text-xs">
              docker compose restart app
            </code>{' '}
            to activate the new config. The sign-in page won't show the new
            buttons until you do.
          </AlertDescription>
          <AlertAction>
            <Button type="button" size="sm" variant="ghost" onClick={() => setNeedsRestart(false)}>
              Dismiss
            </Button>
          </AlertAction>
        </Alert>
      )}

      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <SectionIcon><KeyRound className="h-4 w-4" /></SectionIcon>
            OIDC providers
          </CardTitle>
          <CardAction>
            <Button type="button" onClick={() => setAdding(true)}>
              <Plus data-icon="inline-start" /> Add provider
            </Button>
          </CardAction>
        </CardHeader>
        <CardContent className="flex flex-col gap-3">
          {providers.isLoading && (
            <div className="flex items-center gap-2 text-sm text-muted-foreground">
              <Spinner /> Loading…
            </div>
          )}
          {providers.isError && (
            <Alert variant="destructive">
              <AlertTriangle />
              <AlertTitle>Could not load OIDC providers.</AlertTitle>
              <AlertAction>
                <Button type="button" size="sm" variant="outline" onClick={() => void providers.refetch()} disabled={providers.isFetching}>
                  {providers.isFetching ? <Spinner data-icon="inline-start" /> : null}
                  Retry
                </Button>
              </AlertAction>
            </Alert>
          )}
          {del.isError && (
            <Alert variant="destructive">
              <AlertTriangle />
              <AlertDescription>Could not delete provider: {del.error.message}</AlertDescription>
            </Alert>
          )}
          {providers.data?.length === 0 && (
            <Empty>
              <EmptyHeader>
                <EmptyMedia variant="icon"><KeyRound /></EmptyMedia>
                <EmptyTitle>No OIDC providers configured yet</EmptyTitle>
                <EmptyDescription>Click "Add provider" to wire one up.</EmptyDescription>
              </EmptyHeader>
            </Empty>
          )}
          <ul className="divide-y">
            {providers.data?.map((p) => (
              <li key={p.id} className="flex items-start gap-4 py-3">
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-2">
                    <span className="font-semibold">{p.providerId}</span>
                    {p.isActive ? (
                      <Badge>active</Badge>
                    ) : (
                      <Badge variant="secondary">inactive</Badge>
                    )}
                  </div>
                  <div className="mt-1 break-all text-xs text-muted-foreground">{p.discoveryUrl}</div>
                  <div className="mt-0.5 text-xs text-muted-foreground">
                    client_id: <code className="rounded bg-muted px-1">{p.clientId}</code>
                    {' · '}
                    secret: {p.hasClientSecret ? 'set' : 'missing'}
                    {' · '}
                    scopes: {p.scopes.join(', ')}
                  </div>
                  <div className="mt-2 flex items-center gap-1 text-xs text-muted-foreground">
                    <span>Callback URI:</span>
                    <code className="break-all rounded border bg-background px-1.5 py-0.5">
                      {p.callbackUri}
                    </code>
                    <CopyButton value={p.callbackUri} />
                  </div>
                  <div className="mt-0.5 text-xs text-muted-foreground">
                    Added {new Date(p.createdAt).toLocaleDateString()}
                  </div>
                </div>
                <div className="flex shrink-0 items-center gap-1">
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon-sm"
                    onClick={() => setEditing(p)}
                    title="Edit"
                  >
                    <Edit3 />
                  </Button>
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon-sm"
                    className="text-destructive hover:bg-destructive/10 hover:text-destructive"
                    onClick={() => {
                      if (confirm(`Delete OIDC provider "${p.providerId}"?`)) del.mutate(p.id);
                    }}
                    title="Delete"
                  >
                    <Trash2 />
                  </Button>
                </div>
              </li>
            ))}
          </ul>
        </CardContent>
      </Card>

      {(adding || editing) && (
        <ProviderForm
          initial={editing ?? null}
          onClose={() => {
            setAdding(false);
            setEditing(null);
          }}
          onSaved={(needsRestart) => {
            setAdding(false);
            setEditing(null);
            qc.invalidateQueries({ queryKey: ['admin', 'oidc'] });
            if (needsRestart) setNeedsRestart(true);
          }}
        />
      )}
    </section>
  );
}

// ============================================================================
// Authentication — toggle for local email/password sign-in.
//
// Renders below the OIDC section per the operator flow: "wire up OIDC
// first, then optionally turn off local auth once an OIDC admin exists".
// Mounted only for users with the exact admin role.
// ============================================================================

function AuthenticationSection() {
  const qc = useQueryClient();
  const info = useQuery({
    queryKey: ['admin', 'auth', 'local'],
    queryFn: () => api.get<LocalAuthInfo>('/api/admin/auth/local-auth'),
  });
  const [confirming, setConfirming] = useState<null | 'disable' | 'enable'>(null);
  const [err, setErr] = useState<string | null>(null);

  const toggle = useMutation({
    mutationFn: (disabled: boolean) =>
      api.patch<{ ok: true; localAuthDisabled: boolean }>('/api/admin/auth/local-auth', { disabled }),
    onSuccess: (data) => {
      setConfirming(null);
      setErr(null);
      qc.setQueryData(['admin', 'auth', 'local'], (prev: LocalAuthInfo | undefined) =>
        prev ? { ...prev, localAuthDisabled: data.localAuthDisabled } : prev,
      );
      // The sign-in page reads auth-options — invalidate so a tab
      // already open at /sign-in re-renders against the new state on
      // next navigation.
      qc.invalidateQueries({ queryKey: ['auth-options'] });
    },
    onError: (e) => {
      setErr((e as { message?: string }).message ?? 'Failed to update local auth.');
    },
  });

  if (info.isLoading) {
    return (
      <Card className="max-w-lg">
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <SectionIcon><Shield className="h-4 w-4" /></SectionIcon>
            Authentication
          </CardTitle>
        </CardHeader>
        <CardContent>
          <div className="flex items-center gap-2 text-sm text-muted-foreground">
            <Spinner /> Loading…
          </div>
        </CardContent>
      </Card>
    );
  }
  const data = info.data;
  if (!data) {
    // Surface the server-side message so the operator can debug
    // without tailing the container logs. Common cause: the migration
    // that adds `local_auth_disabled` hasn't run yet (e.g. the new
    // image was pulled before the boot-time migrator had a chance).
    const errMsg =
      (info.error as { message?: string } | null)?.message
      ?? 'Could not load authentication settings.';
    return (
      <Card className="max-w-lg">
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <SectionIcon><Shield className="h-4 w-4" /></SectionIcon>
            Authentication
          </CardTitle>
        </CardHeader>
        <CardContent>
          <Alert variant="destructive">
            <AlertTriangle />
            <AlertTitle>Could not load authentication settings.</AlertTitle>
            <AlertDescription>{errMsg}</AlertDescription>
            <AlertAction>
              <Button type="button" size="sm" variant="outline" onClick={() => void info.refetch()}>
                Retry
              </Button>
            </AlertAction>
          </Alert>
        </CardContent>
      </Card>
    );
  }

  const localAuthDisabled = data.localAuthDisabled;
  const canDisable = data.canDisable;
  // If the flag is currently ON, we should be able to turn it OFF
  // unconditionally — re-enabling never locks anyone out. The guard
  // only applies when transitioning from ON → OFF.
  const disableLocked = !localAuthDisabled && !canDisable;

  return (
    <Card className={clsx('max-w-lg', !localAuthDisabled && 'ring-destructive/30')}>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <SectionIcon tone={localAuthDisabled ? 'default' : 'rose'}><Shield className="h-4 w-4" /></SectionIcon>
          Authentication
        </CardTitle>
        <CardDescription>
          Local email/password sign-in is enabled by default. Turn it off once at least one OIDC user has been promoted to admin.
        </CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-3">
        <div className="flex items-start gap-3">
          {localAuthDisabled ? (
            <Badge variant="destructive" className="mt-0.5 shrink-0">disabled</Badge>
          ) : (
            <Badge className="mt-0.5 shrink-0">enabled</Badge>
          )}
          <div className="min-w-0 flex-1">
            <div className="font-medium">
              Local authentication (email + password)
            </div>
            <p className="mt-1 text-sm text-muted-foreground">
              {localAuthDisabled
                ? 'The email/password form on the sign-in page is hidden. Users can only sign in with an OIDC provider.'
                : 'Users can sign in with email and password.'}
            </p>
          </div>
        </div>

        {disableLocked && (
          <Alert>
            <ShieldAlert />
            <AlertDescription>Disabling local auth requires an OIDC user with admin role</AlertDescription>
          </Alert>
        )}

        {err && (
          <Alert variant="destructive">
            <AlertTriangle />
            <AlertDescription>{err}</AlertDescription>
          </Alert>
        )}

        <div className="flex flex-wrap gap-2 pt-1">
          {localAuthDisabled ? (
            <Button
              type="button"
              variant="outline"
              onClick={() => setConfirming('enable')}
              disabled={toggle.isPending}
            >
              {toggle.isPending ? <Spinner data-icon="inline-start" /> : <Shield data-icon="inline-start" />}
              Re-enable local sign-in
            </Button>
          ) : (
            <Button
              type="button"
              variant="destructive"
              onClick={() => setConfirming('disable')}
              disabled={disableLocked || toggle.isPending}
              title={
                disableLocked
                  ? 'Promote an OIDC user to admin before disabling local sign-in'
                  : undefined
              }
            >
              {toggle.isPending ? <Spinner data-icon="inline-start" /> : <ShieldOff data-icon="inline-start" />}
              Disable
            </Button>
          )}
        </div>
      </CardContent>

      {confirming && (
        <LocalAuthConfirmModal
          intent={confirming}
          busy={toggle.isPending}
          err={err}
          onCancel={() => {
            setConfirming(null);
            setErr(null);
          }}
          onConfirm={() => toggle.mutate(confirming === 'disable')}
        />
      )}
    </Card>
  );
}

function LocalAuthConfirmModal({
  intent,
  busy,
  err,
  onCancel,
  onConfirm,
}: {
  intent: 'disable' | 'enable';
  busy: boolean;
  err: string | null;
  onCancel: () => void;
  onConfirm: () => void;
}) {
  // Type-to-confirm for destructive intent only. The enable path is
  // non-destructive so a single click is enough.
  const [typed, setTyped] = useState('');
  const confirmId = useId();
  const canConfirm = intent === 'enable' || (typed === 'CONFIRM' && !busy);

  return (
    <Dialog open onOpenChange={(open) => { if (!open && !busy) onCancel(); }}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <AlertTriangle className={intent === 'disable' ? 'text-destructive' : 'text-primary'} />
            {intent === 'disable' ? 'Disable local sign-in?' : 'Re-enable local sign-in?'}
          </DialogTitle>
          <DialogDescription asChild>
            <div className="flex flex-col gap-2">
              {intent === 'disable' ? (
                <>
                  <p>
                    Once disabled, <strong>no one can sign in with email and
                    password</strong>. The sign-in page will only show OIDC
                    buttons. Existing sessions stay valid until they expire or
                    the user signs out.
                  </p>
                  <p>
                    You can re-enable local sign-in later from this same screen.
                    The guard requires at least one admin who has signed in via
                    OIDC &mdash; that has been confirmed.
                  </p>
                </>
              ) : (
                <p>
                  Re-enabling restores the email/password form on the sign-in
                  page. No precondition is required.
                </p>
              )}
            </div>
          </DialogDescription>
        </DialogHeader>
        {intent === 'disable' && (
          <Field>
            <FieldLabel htmlFor={confirmId}>
              Type <span className="font-mono">CONFIRM</span> to confirm
            </FieldLabel>
            <Input
              id={confirmId}
              type="text"
              value={typed}
              onChange={(e) => setTyped(e.target.value)}
              autoComplete="off"
              autoFocus
            />
          </Field>
        )}
        {err && (
          <Alert variant="destructive">
            <AlertTriangle />
            <AlertDescription>{err}</AlertDescription>
          </Alert>
        )}
        <DialogFooter>
          <Button type="button" variant="outline" onClick={onCancel} disabled={busy}>
            Cancel
          </Button>
          <Button
            type="button"
            variant={intent === 'disable' ? 'destructive' : 'default'}
            onClick={onConfirm}
            disabled={!canConfirm}
          >
            {busy ? <Spinner data-icon="inline-start" /> : null}
            {busy
              ? 'Updating…'
              : intent === 'disable'
                ? 'Disable local sign-in'
                : 'Re-enable local sign-in'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

// ============================================================================
// Preferences — display currency (per-user, applies everywhere amounts show).
// ============================================================================

function PreferencesSection() {
  const { currency, setCurrency, saving } = useCurrency();
  const currencyId = useId();
  return (
    <Card className="max-w-md">
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <SectionIcon><Coins className="h-4 w-4" /></SectionIcon>
          Display currency
        </CardTitle>
        <CardDescription>
          Controls how amounts are shown throughout the app. Balances are stored numerically; this only changes the currency symbol and formatting.
        </CardDescription>
      </CardHeader>
      <CardContent>
        <FieldGroup>
          <Field>
            <FieldLabel htmlFor={currencyId}>Currency</FieldLabel>
            <Select value={currency} onValueChange={setCurrency} disabled={saving}>
              <SelectTrigger id={currencyId} className="w-full">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectGroup>
                  {SUPPORTED_CURRENCIES.map((c) => (
                    <SelectItem key={c.code} value={c.code}>
                      {c.code} — {c.label}
                    </SelectItem>
                  ))}
                </SelectGroup>
              </SelectContent>
            </Select>
            <FieldDescription>
              Preview: <span className="font-medium text-foreground tabular-nums">{formatMoney(1234.56)}</span>
            </FieldDescription>
          </Field>
        </FieldGroup>
      </CardContent>
    </Card>
  );
}

// ============================================================================
// MCP access — personal access tokens for the MCP server.
// ============================================================================

interface McpToken {
  id: string;
  name: string;
  prefix: string;
  scope: string;
  createdAt: string;
  lastUsedAt: string | null;
  expiresAt: string | null;
}

type TokenLifetime = '30' | '90' | '365' | 'never';

/** Expiry is an exact instant, so show it in the viewer's own calendar. */
function expiryDate(iso: string): string {
  return new Date(iso).toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric' });
}

const TOKEN_LIFETIMES: { value: TokenLifetime; label: string }[] = [
  { value: '30', label: '30 days' },
  { value: '90', label: '90 days' },
  { value: '365', label: '1 year' },
  { value: 'never', label: 'Never' },
];

function McpAccessSection() {
  const qc = useQueryClient();
  const [creating, setCreating] = useState(false);
  const [revoking, setRevoking] = useState<McpToken | null>(null);
  const tokens = useQuery({
    queryKey: ['mcp-tokens'],
    queryFn: () => api.get<McpToken[]>('/api/mcp/tokens'),
    retry: (count, error) => (error as ApiError).status !== 404 && count < 2,
  });
  // 404 means the operator disabled the MCP server (or demo mode is on).
  if ((tokens.error as ApiError | null)?.status === 404) return null;

  const mcpUrl = `${window.location.origin}/mcp`;
  const now = Date.now();

  return (
    <Card className="max-w-lg">
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <SectionIcon><Bot className="h-4 w-4" /></SectionIcon>
          MCP access
        </CardTitle>
        <CardDescription>
          AI assistants and automations can read your balances, transactions, budgets, and reports through
          the Cura Money MCP server. Access is read-only.
        </CardDescription>
        <CardAction>
          <Button type="button" size="sm" onClick={() => setCreating(true)}>
            <Plus data-icon="inline-start" />
            Create token
          </Button>
        </CardAction>
      </CardHeader>
      <CardContent className="flex flex-col gap-4">
        <Field>
          <FieldLabel>MCP server URL</FieldLabel>
          <InputGroup>
            <InputGroupInput readOnly value={mcpUrl} className="font-mono text-xs" aria-label="MCP server URL" />
            <InputGroupAddon align="inline-end">
              <CopyButton value={mcpUrl} />
            </InputGroupAddon>
          </InputGroup>
          <FieldDescription>
            Add this URL to your app with the header{' '}
            <span className="font-mono text-foreground">Authorization: Bearer &lt;token&gt;</span>, using a token
            created here.
          </FieldDescription>
        </Field>

        {tokens.isLoading ? (
          <div className="flex items-center gap-2 text-sm text-muted-foreground">
            <Spinner /> Loading…
          </div>
        ) : tokens.isError ? (
          <Alert variant="destructive">
            <AlertTriangle />
            <AlertTitle>Could not load tokens</AlertTitle>
            <AlertAction>
              <Button type="button" size="sm" variant="outline" onClick={() => void tokens.refetch()}>
                Retry
              </Button>
            </AlertAction>
          </Alert>
        ) : (tokens.data ?? []).length === 0 ? (
          <p className="text-sm text-muted-foreground">No tokens yet. Create one for each app you connect.</p>
        ) : (
          <ul className="flex flex-col divide-y divide-border rounded-lg border border-border">
            {tokens.data!.map((token) => {
              const expired = token.expiresAt !== null && new Date(token.expiresAt).getTime() <= now;
              return (
                <li key={token.id} className="flex items-center gap-3 px-3 py-2.5">
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-2">
                      <span className="truncate text-sm font-medium">{token.name}</span>
                      <span className="shrink-0 font-mono text-xs text-muted-foreground">{token.prefix}…</span>
                    </div>
                    <div className="text-xs text-muted-foreground">
                      {token.lastUsedAt ? `Last used ${timeAgo(token.lastUsedAt)}` : 'Never used'}
                      {' · '}
                      {token.expiresAt === null
                        ? 'No expiry'
                        : expired
                          ? `Expired ${expiryDate(token.expiresAt)}`
                          : `Expires ${expiryDate(token.expiresAt)}`}
                    </div>
                  </div>
                  {expired ? <Badge variant="destructive">Expired</Badge> : <Badge variant="secondary">Read-only</Badge>}
                  <Button
                    type="button"
                    size="sm"
                    variant="ghost"
                    onClick={() => setRevoking(token)}
                    aria-label={`Revoke ${token.name}`}
                  >
                    <Trash2 data-icon="inline-start" />
                    Revoke
                  </Button>
                </li>
              );
            })}
          </ul>
        )}
      </CardContent>
      {creating ? (
        <CreateMcpTokenDialog
          mcpUrl={mcpUrl}
          onClose={() => setCreating(false)}
          onCreated={() => void qc.invalidateQueries({ queryKey: ['mcp-tokens'] })}
        />
      ) : null}
      {revoking ? (
        <ConfirmDialog
          title={`Revoke ${revoking.name}?`}
          confirmLabel="Revoke token"
          destructive
          onClose={() => setRevoking(null)}
          onConfirm={async () => {
            await api.delete(`/api/mcp/tokens/${encodeURIComponent(revoking.id)}`);
            await qc.invalidateQueries({ queryKey: ['mcp-tokens'] });
          }}
        >
          Any app using this token loses access immediately. To reconnect it, create a new token.
        </ConfirmDialog>
      ) : null}
    </Card>
  );
}

function CreateMcpTokenDialog({
  mcpUrl,
  onClose,
  onCreated,
}: {
  mcpUrl: string;
  onClose: () => void;
  onCreated: () => void;
}) {
  const nameId = useId();
  const [name, setName] = useState('');
  const [lifetime, setLifetime] = useState<TokenLifetime>('365');
  const [created, setCreated] = useState<(McpToken & { token: string }) | null>(null);
  const create = useMutation({
    mutationFn: () =>
      api.post<McpToken & { token: string }>('/api/mcp/tokens', {
        name: name.trim(),
        expiresInDays: lifetime === 'never' ? null : Number(lifetime),
      }),
    onSuccess: (data) => {
      setCreated(data);
      onCreated();
    },
  });

  const submit = (event: FormEvent) => {
    event.preventDefault();
    if (!name.trim() || create.isPending) return;
    create.mutate();
  };

  return (
    <Dialog open onOpenChange={(open) => { if (!open) onClose(); }}>
      <DialogContent className="sm:max-w-md">
        {created ? (
          <>
            <DialogHeader>
              <DialogTitle>Copy your token</DialogTitle>
              <DialogDescription>
                This is the only time it's shown. Store it as a secret in your app; if you lose it, revoke it and
                create a new one.
              </DialogDescription>
            </DialogHeader>
            <FieldGroup>
              <Field>
                <FieldLabel>Token for {created.name}</FieldLabel>
                <InputGroup>
                  <InputGroupInput
                    readOnly
                    value={created.token}
                    className="font-mono text-xs"
                    aria-label="Access token"
                    onFocus={(event) => event.currentTarget.select()}
                  />
                  <InputGroupAddon align="inline-end">
                    <CopyButton value={created.token} />
                  </InputGroupAddon>
                </InputGroup>
              </Field>
              <Field>
                <FieldLabel>In your app</FieldLabel>
                <FieldDescription>
                  Server URL <span className="font-mono text-foreground">{mcpUrl}</span>, with the header{' '}
                  <span className="font-mono text-foreground">Authorization: Bearer {created.prefix}…</span>
                </FieldDescription>
              </Field>
            </FieldGroup>
            <DialogFooter>
              <Button type="button" onClick={onClose}>Done</Button>
            </DialogFooter>
          </>
        ) : (
          <form onSubmit={submit} className="contents">
            <DialogHeader>
              <DialogTitle>Create an MCP token</DialogTitle>
              <DialogDescription>
                The token gives read-only access to your finances. Create one per app so you can revoke them
                separately.
              </DialogDescription>
            </DialogHeader>
            <FieldGroup>
              <Field data-invalid={create.isError || undefined}>
                <FieldLabel htmlFor={nameId}>Name</FieldLabel>
                <Input
                  id={nameId}
                  autoFocus
                  maxLength={60}
                  value={name}
                  onChange={(event) => setName(event.target.value)}
                  placeholder="Home Assistant"
                  aria-invalid={create.isError || undefined}
                />
                {create.isError ? (
                  <FieldDescription className="text-destructive">{(create.error as Error).message}</FieldDescription>
                ) : null}
              </Field>
              <Field>
                <FieldLabel>Expires after</FieldLabel>
                <ToggleGroup
                  type="single"
                  variant="outline"
                  spacing={0}
                  value={lifetime}
                  onValueChange={(next) => { if (next) setLifetime(next as TokenLifetime); }}
                  className="w-full"
                  aria-label="Expires after"
                >
                  {TOKEN_LIFETIMES.map((option) => (
                    <ToggleGroupItem key={option.value} value={option.value} className="flex-1">
                      {option.label}
                    </ToggleGroupItem>
                  ))}
                </ToggleGroup>
              </Field>
            </FieldGroup>
            <DialogFooter>
              <Button type="button" variant="outline" onClick={onClose}>Cancel</Button>
              <Button type="submit" disabled={!name.trim() || create.isPending}>
                {create.isPending ? <Spinner data-icon="inline-start" /> : <KeyRound data-icon="inline-start" />}
                Create token
              </Button>
            </DialogFooter>
          </form>
        )}
      </DialogContent>
    </Dialog>
  );
}

// ============================================================================
// Change password — available to every user, with guidance for OIDC accounts.
// ============================================================================

function PasswordSection({ hasCredential, email }: { hasCredential: boolean; email: string }) {
  const authOptions = useQuery({
    queryKey: ['auth-options'],
    queryFn: () => api.get<AuthOptions>('/api/auth-app/auth-options'),
  });
  const [current, setCurrent] = useState('');
  const [next, setNext] = useState('');
  const [confirm, setConfirm] = useState('');
  const [showCurrent, setShowCurrent] = useState(false);
  const [showNext, setShowNext] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [ok, setOk] = useState(false);
  const [busy, setBusy] = useState(false);
  const currentId = useId();
  const nextId = useId();
  const confirmId = useId();

  if (!hasCredential) {
    return (
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <SectionIcon><Lock className="h-4 w-4" /></SectionIcon>
            Change password
          </CardTitle>
          <CardDescription>Only available for accounts with an email/password login.</CardDescription>
        </CardHeader>
        <CardContent>
          <p className="text-sm text-muted-foreground">
            You signed in via an OIDC provider (<span className="font-mono text-xs">{email}</span>),
            so there's no password to change here. Manage it from your identity provider.
          </p>
        </CardContent>
      </Card>
    );
  }

  if (authOptions.isPending || authOptions.isFetching) {
    return (
      <PasswordUnavailable>
        Checking whether password changes are available…
      </PasswordUnavailable>
    );
  }

  if (authOptions.isError) {
    return (
      <PasswordUnavailable>
        <p>Could not verify whether password changes are enabled, so the form is unavailable.</p>
        <Button
          type="button"
          className="mt-3"
          onClick={() => void authOptions.refetch()}
          disabled={authOptions.isFetching}
        >
          {authOptions.isFetching ? <Spinner data-icon="inline-start" /> : null}
          {authOptions.isFetching ? 'Retrying…' : 'Retry'}
        </Button>
      </PasswordUnavailable>
    );
  }

  if (authOptions.data.demoMode) {
    return (
      <PasswordUnavailable>
        Password changes are disabled in public demo mode.
      </PasswordUnavailable>
    );
  }

  if (authOptions.data.localAuthDisabled) {
    return (
      <PasswordUnavailable>
        Local email/password authentication is disabled, so password changes are blocked. Ask an administrator to re-enable local sign-in first.
      </PasswordUnavailable>
    );
  }

  const onSubmit = async (e: FormEvent) => {
    e.preventDefault();
    setErr(null);
    setOk(false);
    if (next.length < 12) return setErr('New password must be at least 12 characters.');
    if (next !== confirm) return setErr('New password and confirmation do not match.');
    setBusy(true);
    try {
      await changePassword(current, next);
      setOk(true);
      setCurrent(''); setNext(''); setConfirm('');
    } catch (e2) {
      const api = e2 as { message?: string };
      setErr(api.message ?? 'Failed to change password.');
    } finally {
      setBusy(false);
    }
  };

  const invalid = Boolean(err);

  return (
    <Card className="max-w-md">
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <SectionIcon><Lock className="h-4 w-4" /></SectionIcon>
          Change password
        </CardTitle>
        <CardDescription>Change the password for your local account.</CardDescription>
      </CardHeader>
      <CardContent>
        <form onSubmit={onSubmit}>
          <FieldGroup>
            <Field data-invalid={invalid || undefined}>
              <FieldLabel htmlFor={currentId}>Current password</FieldLabel>
              <InputGroup>
                <InputGroupInput
                  id={currentId}
                  type={showCurrent ? 'text' : 'password'}
                  value={current}
                  onChange={(e) => setCurrent(e.target.value)}
                  required
                  autoComplete="current-password"
                  aria-invalid={invalid || undefined}
                />
                <InputGroupAddon align="inline-end">
                  <InputGroupButton
                    type="button"
                    onClick={() => setShowCurrent((s) => !s)}
                    aria-label={showCurrent ? 'Hide current password' : 'Show current password'}
                  >
                    {showCurrent ? <EyeOff /> : <Eye />}
                  </InputGroupButton>
                </InputGroupAddon>
              </InputGroup>
            </Field>
            <Field data-invalid={invalid || undefined}>
              <FieldLabel htmlFor={nextId}>New password</FieldLabel>
              <InputGroup>
                <InputGroupInput
                  id={nextId}
                  type={showNext ? 'text' : 'password'}
                  value={next}
                  onChange={(e) => setNext(e.target.value)}
                  required
                  minLength={12}
                  autoComplete="new-password"
                  aria-invalid={invalid || undefined}
                />
                <InputGroupAddon align="inline-end">
                  <InputGroupButton
                    type="button"
                    onClick={() => setShowNext((s) => !s)}
                    aria-label={showNext ? 'Hide new password' : 'Show new password'}
                  >
                    {showNext ? <EyeOff /> : <Eye />}
                  </InputGroupButton>
                </InputGroupAddon>
              </InputGroup>
              <FieldDescription>Min 12 characters</FieldDescription>
            </Field>
            <Field data-invalid={invalid || undefined}>
              <FieldLabel htmlFor={confirmId}>Confirm new password</FieldLabel>
              <Input
                id={confirmId}
                type={showNext ? 'text' : 'password'}
                value={confirm}
                onChange={(e) => setConfirm(e.target.value)}
                required
                minLength={12}
                autoComplete="new-password"
                aria-invalid={invalid || undefined}
              />
            </Field>
            {err && (
              <Alert variant="destructive">
                <AlertTriangle />
                <AlertDescription>{err}</AlertDescription>
              </Alert>
            )}
            {ok && (
              <Alert>
                <Check />
                <AlertDescription>Password changed.</AlertDescription>
              </Alert>
            )}
            <Button type="submit" disabled={busy}>
              {busy ? <Spinner data-icon="inline-start" /> : <KeySquare data-icon="inline-start" />}
              {busy ? 'Changing…' : 'Change password'}
            </Button>
          </FieldGroup>
        </form>
      </CardContent>
    </Card>
  );
}

function PasswordUnavailable({ children }: { children: ReactNode }) {
  return (
    <Card className="max-w-md">
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <SectionIcon><Lock className="h-4 w-4" /></SectionIcon>
          Change password
        </CardTitle>
        <CardDescription>Change the password for your local account.</CardDescription>
      </CardHeader>
      <CardContent>
        <div className="text-sm text-muted-foreground" role="status">
          {children}
        </div>
      </CardContent>
    </Card>
  );
}

// ============================================================================
// Users — list + delete (OIDC users only; local admins are protected).
// ============================================================================

function UsersSection() {
  const qc = useQueryClient();
  const me = useQuery({ queryKey: ['me'], queryFn: fetchMe });
  const users = useQuery({
    queryKey: ['admin', 'users'],
    queryFn: () => api.get<AdminUser[]>('/api/admin/users'),
  });
  const [confirmDelete, setConfirmDelete] = useState<AdminUser | null>(null);
  const [deleteErr, setDeleteErr] = useState<string | null>(null);
  const [roleErr, setRoleErr] = useState<{ userId: string; message: string } | null>(null);
  const [resetPasswordUser, setResetPasswordUser] = useState<AdminUser | null>(null);
  const [resetPasswordValue, setResetPasswordValue] = useState('');
  const [resetPasswordErr, setResetPasswordErr] = useState<string | null>(null);
  const [createOpen, setCreateOpen] = useState(false);
  const [newName, setNewName] = useState('');
  const [newEmail, setNewEmail] = useState('');
  const [newPassword, setNewPassword] = useState('');
  const [createErr, setCreateErr] = useState<string | null>(null);

  const closeCreateModal = () => {
    setCreateOpen(false);
    setNewName('');
    setNewEmail('');
    setNewPassword('');
    setCreateErr(null);
  };

  const createUser = useMutation({
    mutationFn: () => api.post<AdminUser>('/api/admin/users', {
      name: newName.trim(),
      email: newEmail.trim(),
      password: newPassword,
    }),
    onSuccess: () => {
      closeCreateModal();
      qc.invalidateQueries({ queryKey: ['admin', 'users'] });
    },
    onError: (error) => {
      setCreateErr((error as { message?: string }).message ?? 'Failed to create user.');
    },
  });

  const del = useMutation({
    mutationFn: (id: string) => api.delete<{ ok: true; deletedRows: number }>(`/api/admin/users/${id}`),
    onSuccess: (data) => {
      qc.invalidateQueries({ queryKey: ['admin', 'users'] });
      setConfirmDelete(null);
      setDeleteErr(null);
      // Re-fetch `me` in case the current user changed (unlikely but harmless).
      qc.invalidateQueries({ queryKey: ['me'] });
      // Silent success — the row disappearing from the list is the
      // feedback. We log the row count for ops debugging.
      // eslint-disable-next-line no-console
      console.info(`[admin] deleted user, ${data.deletedRows} rows of data removed`);
    },
    onError: (e) => {
      const err = e as { message?: string };
      setDeleteErr(err.message ?? 'Failed to delete user.');
    },
  });

  const setPassword = useMutation({
    mutationFn: ({ id, password }: { id: string; password: string }) =>
      api.post<{ ok: true }>(`/api/admin/users/${id}/password`, { password }),
    onSuccess: () => {
      setResetPasswordUser(null);
      setResetPasswordValue('');
      setResetPasswordErr(null);
    },
    onError: (e) => {
      const err = e as { message?: string };
      setResetPasswordErr(err.message ?? 'Failed to set password.');
    },
  });

  const setRole = useMutation({
    mutationFn: ({ id, role }: { id: string; role: 'admin' | 'user' }) =>
      api.patch<{ ok: true; id: string; role: string | null }>(`/api/admin/users/${id}`, { role }),
    onSuccess: (_data, vars) => {
      setRoleErr(null);
      qc.invalidateQueries({ queryKey: ['admin', 'users'] });
      // If the admin just changed their own role, refetch me so the page
      // guard reflects the new state. Server still enforces on every
      // request; this is just a UI cache concern.
      if (me.data?.user.id === vars.id) qc.invalidateQueries({ queryKey: ['me'] });
    },
    onError: (e, vars) => {
      const err = e as { message?: string };
      setRoleErr({ userId: vars.id, message: err.message ?? 'Failed to update role.' });
    },
    onSettled: () => {
      // Always refetch so the select reflects the canonical value
      // (in case the server applied a normalized value, e.g. 'user' -> null).
      qc.invalidateQueries({ queryKey: ['admin', 'users'] });
    },
  });

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <SectionIcon><Users className="h-4 w-4" /></SectionIcon>
          Users
        </CardTitle>
        <CardAction>
          <Button type="button" onClick={() => setCreateOpen(true)}>
            <Plus data-icon="inline-start" /> Add user
          </Button>
        </CardAction>
      </CardHeader>
      <CardContent className="flex flex-col gap-3">
        {users.isLoading && (
          <div className="flex items-center gap-2 text-sm text-muted-foreground">
            <Spinner /> Loading…
          </div>
        )}
        {users.isError && (
          <Alert variant="destructive">
            <AlertTriangle />
            <AlertTitle>Could not load users.</AlertTitle>
            <AlertAction>
              <Button type="button" size="sm" variant="outline" onClick={() => void users.refetch()} disabled={users.isFetching}>
                {users.isFetching ? <Spinner data-icon="inline-start" /> : null}
                Retry
              </Button>
            </AlertAction>
          </Alert>
        )}
        {users.data?.length === 0 && (
          <Empty>
            <EmptyHeader>
              <EmptyMedia variant="icon"><Users /></EmptyMedia>
              <EmptyTitle>No users</EmptyTitle>
            </EmptyHeader>
          </Empty>
        )}
        <ul className="divide-y">
          {users.data?.map((u) => {
            const isLocal = u.hasCredential;
            const isProtectedAdmin = u.isProtected;
            const currentRole: 'admin' | 'user' = u.role === 'admin' ? 'admin' : 'user';
            const roleErrForRow = roleErr?.userId === u.id ? roleErr.message : null;
            const lockTitle = protectionTooltip(u.protectionReason);
            const roleId = `user-role-${u.id}`;
            return (
              <li key={u.id} className="flex flex-col items-stretch gap-3 py-3 sm:flex-row sm:items-center sm:gap-4">
                <div className="min-w-0 flex-1">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="truncate font-medium">{u.name}</span>
                    {isLocal ? (
                      <Badge variant="outline">local</Badge>
                    ) : (
                      <Badge variant="secondary">OIDC</Badge>
                    )}
                    {isProtectedAdmin && (
                      <span title={lockTitle} aria-label={lockTitle}>
                        <Lock className="size-3.5 text-primary" />
                      </span>
                    )}
                  </div>
                  <div className="mt-0.5 truncate text-xs text-muted-foreground">
                    {u.email}
                  </div>
                  {roleErrForRow && (
                    <Alert variant="destructive" className="mt-1">
                      <AlertTriangle />
                      <AlertDescription>{roleErrForRow}</AlertDescription>
                    </Alert>
                  )}
                </div>
                <Field orientation="horizontal" className="w-auto shrink-0 sm:w-auto">
                  <FieldLabel htmlFor={roleId} className="text-xs text-muted-foreground">Role</FieldLabel>
                  <Select
                    value={currentRole}
                    onValueChange={(next) => {
                      setRoleErr(null);
                      setRole.mutate({ id: u.id, role: next as 'admin' | 'user' });
                    }}
                    disabled={setRole.isPending}
                  >
                    <SelectTrigger id={roleId} size="sm" title={isProtectedAdmin ? lockTitle : 'Change user role'}>
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectGroup>
                        <SelectItem value="user">User</SelectItem>
                        <SelectItem value="admin">Admin</SelectItem>
                      </SelectGroup>
                    </SelectContent>
                  </Select>
                </Field>
                {isLocal && (
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon"
                    onClick={() => setResetPasswordUser(u)}
                    aria-label={`Reset password for ${u.email}`}
                    title="Reset password"
                  >
                    <KeyRound />
                  </Button>
                )}
                {isProtectedAdmin ? (
                  <span title={lockTitle} aria-label={lockTitle}>
                    <Lock className="size-4 shrink-0 text-primary" />
                  </span>
                ) : (
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon"
                    className="text-destructive hover:bg-destructive/10 hover:text-destructive"
                    onClick={() => setConfirmDelete(u)}
                    aria-label={`Delete ${u.email}`}
                    title="Delete user and all data"
                  >
                    <Trash2 />
                  </Button>
                )}
              </li>
            );
          })}
        </ul>
      </CardContent>

      {createOpen && (
        <AddUserModal
          name={newName}
          email={newEmail}
          password={newPassword}
          busy={createUser.isPending}
          err={createErr}
          onNameChange={setNewName}
          onEmailChange={setNewEmail}
          onPasswordChange={setNewPassword}
          onClose={closeCreateModal}
          onSubmit={() => {
            setCreateErr(null);
            createUser.mutate();
          }}
        />
      )}

      {confirmDelete && (
        <DeleteUserModal
          user={confirmDelete}
          busy={del.isPending}
          err={deleteErr}
          onCancel={() => {
            setConfirmDelete(null);
            setDeleteErr(null);
          }}
          onConfirm={() => del.mutate(confirmDelete.id)}
        />
      )}

      {resetPasswordUser && (
        <ResetPasswordModal
          user={resetPasswordUser}
          password={resetPasswordValue}
          busy={setPassword.isPending}
          err={resetPasswordErr}
          onPasswordChange={setResetPasswordValue}
          onClose={() => {
            setResetPasswordUser(null);
            setResetPasswordValue('');
            setResetPasswordErr(null);
          }}
          onSubmit={() => {
            setResetPasswordErr(null);
            setPassword.mutate({ id: resetPasswordUser.id, password: resetPasswordValue });
          }}
        />
      )}
    </Card>
  );
}

function ResetPasswordModal({
  user,
  password,
  busy,
  err,
  onPasswordChange,
  onClose,
  onSubmit,
}: {
  user: AdminUser;
  password: string;
  busy: boolean;
  err: string | null;
  onPasswordChange: (value: string) => void;
  onClose: () => void;
  onSubmit: () => void;
}) {
  const passwordId = useId();
  const invalid = Boolean(err);
  return (
    <Dialog open onOpenChange={(open) => { if (!open && !busy) onClose(); }}>
      <DialogContent className="sm:max-w-md">
        <form
          className="contents"
          onSubmit={(event) => {
            event.preventDefault();
            onSubmit();
          }}
        >
          <DialogHeader>
            <DialogTitle>Reset password</DialogTitle>
            <DialogDescription>
              Set a new password for <span className="font-medium text-foreground">{user.name}</span>{' '}
              (<span className="font-mono text-xs">{user.email}</span>). They'll need it the next time they sign in.
            </DialogDescription>
          </DialogHeader>
          <FieldGroup>
            <Field data-invalid={invalid || undefined}>
              <FieldLabel htmlFor={passwordId}>New password</FieldLabel>
              <Input
                id={passwordId}
                type="password"
                value={password}
                onChange={(event) => onPasswordChange(event.target.value)}
                minLength={12}
                maxLength={256}
                required
                autoFocus
                autoComplete="new-password"
                aria-invalid={invalid || undefined}
              />
              <FieldDescription>Min 12 characters</FieldDescription>
            </Field>
          </FieldGroup>
          {err && (
            <Alert variant="destructive">
              <AlertTriangle />
              <AlertDescription>{err}</AlertDescription>
            </Alert>
          )}
          <DialogFooter>
            <Button type="button" variant="outline" onClick={onClose} disabled={busy}>
              Cancel
            </Button>
            <Button type="submit" disabled={busy}>
              {busy ? <Spinner data-icon="inline-start" /> : null}
              {busy ? 'Saving…' : 'Set password'}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

function AddUserModal({
  name,
  email,
  password,
  busy,
  err,
  onNameChange,
  onEmailChange,
  onPasswordChange,
  onClose,
  onSubmit,
}: {
  name: string;
  email: string;
  password: string;
  busy: boolean;
  err: string | null;
  onNameChange: (value: string) => void;
  onEmailChange: (value: string) => void;
  onPasswordChange: (value: string) => void;
  onClose: () => void;
  onSubmit: () => void;
}) {
  const nameId = useId();
  const emailId = useId();
  const passwordId = useId();
  const invalid = Boolean(err);
  return (
    <Dialog open onOpenChange={(open) => { if (!open && !busy) onClose(); }}>
      <DialogContent className="sm:max-w-md">
        <form
          className="contents"
          onSubmit={(event) => {
            event.preventDefault();
            onSubmit();
          }}
        >
          <DialogHeader>
            <DialogTitle>Add user</DialogTitle>
            <DialogDescription>Create a local account with a temporary password.</DialogDescription>
          </DialogHeader>
          <FieldGroup>
            <Field data-invalid={invalid || undefined}>
              <FieldLabel htmlFor={nameId}>Name</FieldLabel>
              <Input
                id={nameId}
                value={name}
                onChange={(event) => onNameChange(event.target.value)}
                maxLength={120}
                required
                autoFocus
                autoComplete="name"
                aria-invalid={invalid || undefined}
              />
            </Field>
            <Field data-invalid={invalid || undefined}>
              <FieldLabel htmlFor={emailId}>Email</FieldLabel>
              <Input
                id={emailId}
                type="email"
                value={email}
                onChange={(event) => onEmailChange(event.target.value)}
                required
                autoComplete="email"
                aria-invalid={invalid || undefined}
              />
            </Field>
            <Field data-invalid={invalid || undefined}>
              <FieldLabel htmlFor={passwordId}>Temporary password</FieldLabel>
              <Input
                id={passwordId}
                type="password"
                value={password}
                onChange={(event) => onPasswordChange(event.target.value)}
                minLength={12}
                maxLength={256}
                required
                autoComplete="new-password"
                aria-invalid={invalid || undefined}
              />
              <FieldDescription>Min 12 characters</FieldDescription>
            </Field>
          </FieldGroup>
          {err && (
            <Alert variant="destructive">
              <AlertTriangle />
              <AlertDescription>{err}</AlertDescription>
            </Alert>
          )}
          <DialogFooter>
            <Button type="button" variant="outline" onClick={onClose} disabled={busy}>
              Cancel
            </Button>
            <Button type="submit" disabled={busy}>
              {busy ? <Spinner data-icon="inline-start" /> : null}
              {busy ? 'Adding…' : 'Add user'}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

function DeleteUserModal({
  user,
  busy,
  err,
  onCancel,
  onConfirm,
}: {
  user: AdminUser;
  busy: boolean;
  err: string | null;
  onCancel: () => void;
  onConfirm: () => void;
}) {
  // The user has to TYPE the user's email to confirm. This is a
  // destructive action and the typed email matches the standard
  // "type the name to confirm" pattern used by GitHub, AWS, etc.
  const [typed, setTyped] = useState('');
  const confirmId = useId();
  const canConfirm = typed === user.email && !busy;
  return (
    <Dialog open onOpenChange={(open) => { if (!open && !busy) onCancel(); }}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <AlertTriangle className="text-destructive" />
            Delete user?
          </DialogTitle>
          <DialogDescription asChild>
            <div className="flex flex-col gap-2">
              <p>
                This will permanently delete <span className="font-medium text-foreground">{user.name}</span>{' '}
                (<span className="font-mono text-xs">{user.email}</span>) and <strong>all of their data</strong>:
              </p>
              <ul className="ml-5 list-disc">
                <li>Transactions</li>
                <li>Accounts</li>
                <li>Categories and sub-categories</li>
                <li>Monthly budget rows</li>
                <li>Settings</li>
                <li>Better Auth session + OIDC account link</li>
              </ul>
              <p className="font-medium text-destructive">
                This cannot be undone.
              </p>
            </div>
          </DialogDescription>
        </DialogHeader>
        <Field>
          <FieldLabel htmlFor={confirmId}>
            Type <span className="font-mono">{user.email}</span> to confirm
          </FieldLabel>
          <Input
            id={confirmId}
            type="text"
            value={typed}
            onChange={(e) => setTyped(e.target.value)}
            autoComplete="off"
            autoFocus
          />
        </Field>
        {err && (
          <Alert variant="destructive">
            <AlertTriangle />
            <AlertDescription>{err}</AlertDescription>
          </Alert>
        )}
        <DialogFooter>
          <Button type="button" variant="outline" onClick={onCancel} disabled={busy}>
            Cancel
          </Button>
          <Button type="button" variant="destructive" onClick={onConfirm} disabled={!canConfirm}>
            {busy ? <Spinner data-icon="inline-start" /> : null}
            {busy ? 'Deleting…' : 'Delete user + data'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

// ============================================================================
// Provider form — used by the OIDC section.
// ============================================================================

function ProviderForm({
  initial,
  onClose,
  onSaved,
}: {
  initial: OidcProvider | null;
  onClose: () => void;
  onSaved: (needsRestart: boolean) => void;
}) {
  const [form, setForm] = useState(
    initial
      ? {
          providerId: initial.providerId,
          discoveryUrl: initial.discoveryUrl,
          clientId: initial.clientId,
          clientSecret: '',
          scopes: initial.scopes.join(', '),
        }
      : EMPTY_PROVIDER_FORM,
  );
  const [testResult, setTestResult] = useState<DiscoveryResult | null>(null);
  const [testing, setTesting] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const isEdit = !!initial;
  const locked = busy || testing;

  const onTest = async () => {
    setTesting(true);
    setTestResult(null);
    setErr(null);
    try {
      const body: Record<string, string> = {
        discoveryUrl: form.discoveryUrl,
        clientId: form.clientId,
      };
      if (form.clientSecret) body.clientSecret = form.clientSecret;
      const r = await api.post<DiscoveryResult>('/api/admin/oidc/providers/test', body);
      setTestResult(r);
    } catch (e) {
      const msg = (e as Error).message;
      setTestResult({ ok: false, error: msg });
    } finally {
      setTesting(false);
    }
  };

  const onSubmit = async (e: FormEvent) => {
    e.preventDefault();
    setErr(null);
    setBusy(true);
    try {
      const scopes = form.scopes.split(',').map((s) => s.trim()).filter(Boolean);
      let needsRestart = false;
      if (isEdit && initial) {
        const patch: Record<string, unknown> = {
          providerId: form.providerId,
          discoveryUrl: form.discoveryUrl,
          clientId: form.clientId,
          scopes,
        };
        if (form.clientSecret) patch.clientSecret = form.clientSecret;
        const res = await api.patch<{ restart_required?: boolean }>(
          `/api/admin/oidc/providers/${initial.id}`,
          patch,
        );
        needsRestart = !!res?.restart_required;
      } else {
        if (!form.clientSecret) {
          setErr('Client secret is required when adding a new provider');
          setBusy(false);
          return;
        }
        const res = await api.post<{ restart_required?: boolean }>(
          '/api/admin/oidc/providers',
          {
            providerId: form.providerId,
            discoveryUrl: form.discoveryUrl,
            clientId: form.clientId,
            clientSecret: form.clientSecret,
            scopes,
          },
        );
        needsRestart = !!res?.restart_required;
      }
      onSaved(needsRestart);
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog open onOpenChange={(open) => { if (!open && !locked) onClose(); }}>
      <DialogContent className="sm:max-w-lg">
        <form onSubmit={onSubmit} className="contents">
          <DialogHeader>
            <DialogTitle>
              {isEdit ? `Edit ${initial?.providerId}` : 'Add OIDC provider'}
            </DialogTitle>
            <DialogDescription>
              {isEdit
                ? 'Update this identity provider. Leave the client secret blank to keep the current value.'
                : 'Connect an OpenID Connect identity provider for sign-in.'}
            </DialogDescription>
          </DialogHeader>

          <FieldGroup>
            <ProviderField
              label="Provider ID (slug)"
              value={form.providerId}
              onChange={(v) => setForm({ ...form, providerId: v })}
              hint="Used in /api/auth/sign-in/oauth/<providerId>"
              disabled={isEdit}
              required
            />
            <ProviderField
              label="Discovery URL"
              value={form.discoveryUrl}
              onChange={(v) => setForm({ ...form, discoveryUrl: v })}
              placeholder="https://id.example.com/.well-known/openid-configuration"
              required
            />
            <ProviderField
              label="Client ID"
              value={form.clientId}
              onChange={(v) => setForm({ ...form, clientId: v })}
              required
            />
            <ProviderField
              label={isEdit ? 'Client secret (leave blank to keep current)' : 'Client secret'}
              value={form.clientSecret}
              onChange={(v) => setForm({ ...form, clientSecret: v })}
              type="password"
              required={!isEdit}
              invalid={Boolean(err) && !isEdit && !form.clientSecret}
            />
            <ProviderField
              label="Scopes (comma-separated)"
              value={form.scopes}
              onChange={(v) => setForm({ ...form, scopes: v })}
              hint="Standard: openid, email, profile"
            />
          </FieldGroup>

          {form.providerId.trim() && (
            <Alert>
              <AlertTitle>Register this callback URI in your IdP first</AlertTitle>
              <AlertDescription>
                <p>
                  Before saving here, copy this exact value into your IdP's
                  &quot;Allowed redirect URIs&quot; (Pocket ID) / &quot;Redirect URIs&quot;
                  (Authentik / Keycloak). If the strings differ by even a
                  trailing slash, the IdP will reject the sign-in with{' '}
                  <code className="rounded bg-muted px-1">redirect_uri not registered</code>.
                </p>
                <div className="mt-2 flex items-center gap-1 rounded border bg-background px-2 py-1.5">
                  <code className="flex-1 break-all font-mono text-xs text-foreground">
                    {predictedCallbackUri(form.providerId)}
                  </code>
                  <CopyButton value={predictedCallbackUri(form.providerId)} />
                </div>
              </AlertDescription>
            </Alert>
          )}

          <div className="flex flex-wrap items-center gap-2">
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={() => void onTest()}
              disabled={testing || !form.discoveryUrl || !form.clientId}
            >
              {testing ? <Spinner data-icon="inline-start" /> : <RefreshCw data-icon="inline-start" />}
              {testing ? 'Testing…' : 'Test discovery'}
            </Button>
            {testResult?.ok && (
              <span className="flex items-center gap-1 text-xs text-emerald-400">
                <ShieldCheck className="size-3" /> reachable
              </span>
            )}
            {testResult && !testResult.ok && (
              <span className="text-xs text-destructive">{testResult.error}</span>
            )}
          </div>

          {err && (
            <Alert variant="destructive">
              <AlertTriangle />
              <AlertDescription>{err}</AlertDescription>
            </Alert>
          )}

          <DialogFooter>
            <Button type="button" variant="outline" onClick={onClose} disabled={locked}>
              Cancel
            </Button>
            <Button type="submit" disabled={busy}>
              {busy ? <Spinner data-icon="inline-start" /> : null}
              {busy ? 'Saving…' : isEdit ? 'Save changes' : 'Add provider'}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

function ProviderField({
  label,
  value,
  onChange,
  type = 'text',
  hint,
  disabled,
  placeholder,
  required,
  invalid,
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  type?: string;
  hint?: string;
  disabled?: boolean;
  placeholder?: string;
  required?: boolean;
  invalid?: boolean;
}) {
  const id = useId();
  return (
    <Field data-invalid={invalid || undefined}>
      <FieldLabel htmlFor={id}>{label}</FieldLabel>
      <Input
        id={id}
        type={type}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={placeholder}
        disabled={disabled}
        required={required}
        aria-invalid={invalid || undefined}
      />
      {hint ? <FieldDescription>{hint}</FieldDescription> : null}
    </Field>
  );
}

function predictedCallbackUri(providerId: string): string {
  if (!providerId.trim()) return '';
  return `${window.location.origin}/api/auth/oauth2/callback/${encodeURIComponent(
    providerId.trim(),
  )}`;
}

function CopyButton({ value }: { value: string }) {
  const [copied, setCopied] = useState(false);
  const onCopy = async () => {
    try {
      await navigator.clipboard.writeText(value);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      const ta = document.createElement('textarea');
      ta.value = value;
      ta.style.position = 'fixed';
      ta.style.opacity = '0';
      document.body.appendChild(ta);
      ta.select();
      try {
        document.execCommand('copy');
        setCopied(true);
        setTimeout(() => setCopied(false), 1500);
      } catch {
        /* give up silently */
      }
      document.body.removeChild(ta);
    }
  };
  return (
    <Button
      type="button"
      variant="ghost"
      size="icon-xs"
      onClick={() => void onCopy()}
      title={copied ? 'Copied!' : 'Copy'}
      aria-label="Copy to clipboard"
    >
      {copied ? <Check className="text-emerald-400" /> : <Copy />}
    </Button>
  );
}
