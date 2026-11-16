// Rendering helpers for component tests: the app's providers (React Query, router) with test defaults.
import { QueryClientProvider, type QueryClient } from "@tanstack/react-query";
import { render, type RenderOptions, type RenderResult } from "@testing-library/react";
import userEvent, { type UserEvent } from "@testing-library/user-event";
import type { ReactElement, ReactNode } from "react";
import { MemoryRouter } from "react-router";
import { createQueryClient } from "@/app/queryClient";

/** The app's QueryClient defaults without retries (and without garbage-collection timers). */
export function createTestQueryClient(): QueryClient {
  const client = createQueryClient();
  const defaults = client.getDefaultOptions();
  client.setDefaultOptions({ ...defaults, queries: { ...defaults.queries, retry: false, gcTime: Number.POSITIVE_INFINITY }, mutations: { ...defaults.mutations, retry: false } });
  return client;
}

export interface ProvidersOptions extends Omit<RenderOptions, "wrapper"> {
  /** Initial URL of the in-memory router (default "/"). */
  route?: string;
  queryClient?: QueryClient;
}

export interface ProvidersResult extends RenderResult {
  user: UserEvent;
  queryClient: QueryClient;
}

/** Renders `ui` inside QueryClientProvider + MemoryRouter and returns a user-event session bound to it. */
export function renderWithProviders(ui: ReactElement, options: ProvidersOptions = {}): ProvidersResult {
  const { route = "/", queryClient = createTestQueryClient(), ...rest } = options;
  const user = userEvent.setup();
  function Providers({ children }: { children: ReactNode }) {
    return (
      <QueryClientProvider client={queryClient}>
        <MemoryRouter initialEntries={[route]}>{children}</MemoryRouter>
      </QueryClientProvider>
    );
  }
  return { user, queryClient, ...render(ui, { wrapper: Providers, ...rest }) };
}
