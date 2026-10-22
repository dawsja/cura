import { useEffect, useId, useState, type FormEvent } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { AlertTriangle, Bot, CheckCircle2, Eye, XCircle } from 'lucide-react';
import { api, type ApiError } from '../lib/api';
import { Alert, AlertDescription, AlertTitle } from '../components/ui/alert';
import { Button } from '../components/ui/button';
import { Card, CardContent, CardDescription, CardFooter, CardHeader, CardTitle } from '../components/ui/card';
import { Field, FieldDescription, FieldError, FieldLabel } from '../components/ui/field';
import { Input } from '../components/ui/input';
import { Spinner } from '../components/ui/spinner';

interface PendingRequest {
  clientId: string;
  scope: string;
  expiresAt: string;
}

const CODE_ALPHABET = /[^BCDFGHJKLMNPQRSTVWXZ]/g;

/** Uppercase, strip anything outside the code alphabet, and insert the dash. */
function formatCode(input: string): string {
  const raw = input.toUpperCase().replace(CODE_ALPHABET, '').slice(0, 8);
  return raw.length > 4 ? `${raw.slice(0, 4)}-${raw.slice(4)}` : raw;
}

/**
 * OAuth device-code approval (RFC 8628 verification_uri). An MCP client
 * shows the user a code and this URL; the user confirms the code here and
 * approves or denies read-only access.
 */
export function Device() {
  const [params] = useSearchParams();
  const qc = useQueryClient();
  const inputId = useId();
  const [initialCode] = useState(() => formatCode(params.get('user_code') ?? ''));
  const [input, setInput] = useState(initialCode);
  const [submitted, setSubmitted] = useState(initialCode.length === 9 ? initialCode : '');
  const [outcome, setOutcome] = useState<'approved' | 'denied' | null>(null);

  const lookup = useQuery({
    queryKey: ['mcp-device', submitted],
    queryFn: () => api.get<PendingRequest>(`/api/mcp/device?userCode=${encodeURIComponent(submitted)}`),
    enabled: submitted.length === 9 && outcome === null,
    retry: false,
    staleTime: Infinity,
  });

  const decide = useMutation({
    mutationFn: (approve: boolean) => api.post('/api/mcp/device/decision', { userCode: submitted, approve }),
    onSuccess: (_data, approve) => {
      setOutcome(approve ? 'approved' : 'denied');
      void qc.invalidateQueries({ queryKey: ['mcp-grants'] });
    },
  });

  // Keep the URL shareable but drop the code once the request is finished.
  useEffect(() => {
    if (outcome) window.history.replaceState(null, '', '/device');
  }, [outcome]);

  const onSubmit = (e: FormEvent) => {
    e.preventDefault();
    decide.reset();
    const code = formatCode(input);
    if (code === submitted) void lookup.refetch();
    else setSubmitted(code);
  };

  const lookupError = lookup.error as ApiError | null;

  return (
    <div className="mx-auto flex w-full max-w-md flex-col gap-6 py-4">
      <div className="flex flex-col gap-1">
        <h1 className="text-2xl font-bold">Connect an app</h1>
        <p className="text-sm text-muted-foreground">
          Approve an AI assistant or automation that asked to access your Cura Money data.
        </p>
      </div>

      {outcome === 'approved' ? (
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <CheckCircle2 className="size-5 text-emerald-400" />
              {lookup.data?.clientId ?? 'App'} is connected
            </CardTitle>
            <CardDescription>
              You can return to the app now. Disconnect it any time from Settings → Connected apps.
            </CardDescription>
          </CardHeader>
          <CardFooter>
            <Button asChild variant="outline">
              <Link to="/settings">Manage connected apps</Link>
            </Button>
          </CardFooter>
        </Card>
      ) : outcome === 'denied' ? (
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <XCircle className="size-5 text-destructive" />
              Request denied
            </CardTitle>
            <CardDescription>The app was not given access. You can close this page.</CardDescription>
          </CardHeader>
        </Card>
      ) : lookup.data ? (
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <span className="flex size-7 items-center justify-center rounded-lg bg-primary/10 text-primary">
                <Bot className="size-4" />
              </span>
              <span className="min-w-0 truncate">{lookup.data.clientId}</span>
            </CardTitle>
            <CardDescription>
              wants to connect using code <span className="font-mono text-foreground">{submitted}</span>. Check that
              this matches the code shown in the app. The app chose its own name, so only approve requests you
              started.
            </CardDescription>
          </CardHeader>
          <CardContent className="flex flex-col gap-3">
            <div className="flex gap-3 rounded-lg border border-border p-3 text-sm">
              <Eye className="mt-0.5 size-4 shrink-0 text-muted-foreground" />
              <div>
                <div className="font-medium">Read-only access</div>
                <div className="text-muted-foreground">
                  Accounts, balances, transactions, budgets, goals, recurring charges, and reports. It cannot
                  change anything.
                </div>
              </div>
            </div>
            {decide.isError ? (
              <Alert variant="destructive">
                <AlertTriangle />
                <AlertTitle>Could not complete the request</AlertTitle>
                <AlertDescription>{(decide.error as Error).message}</AlertDescription>
              </Alert>
            ) : null}
          </CardContent>
          <CardFooter className="flex justify-end gap-2">
            <Button type="button" variant="outline" disabled={decide.isPending} onClick={() => decide.mutate(false)}>
              Deny
            </Button>
            <Button type="button" disabled={decide.isPending} onClick={() => decide.mutate(true)}>
              {decide.isPending ? <Spinner data-icon="inline-start" /> : null}
              Approve
            </Button>
          </CardFooter>
        </Card>
      ) : (
        <Card>
          <form onSubmit={onSubmit}>
            <CardContent>
              <Field data-invalid={lookupError ? true : undefined}>
                <FieldLabel htmlFor={inputId}>Code shown by the app</FieldLabel>
                <Input
                  id={inputId}
                  value={input}
                  onChange={(e) => setInput(formatCode(e.target.value))}
                  placeholder="XXXX-XXXX"
                  autoComplete="off"
                  autoCapitalize="characters"
                  spellCheck={false}
                  autoFocus
                  aria-invalid={lookupError ? true : undefined}
                  className="h-12 text-center font-mono text-xl tracking-[0.3em] uppercase"
                />
                {lookupError ? (
                  <FieldError>{lookupError.message}</FieldError>
                ) : (
                  <FieldDescription>Codes expire 10 minutes after the app shows them.</FieldDescription>
                )}
              </Field>
            </CardContent>
            <CardFooter className="mt-4 flex justify-end">
              <Button type="submit" disabled={formatCode(input).length !== 9 || lookup.isFetching}>
                {lookup.isFetching ? <Spinner data-icon="inline-start" /> : null}
                Continue
              </Button>
            </CardFooter>
          </form>
        </Card>
      )}
    </div>
  );
}
