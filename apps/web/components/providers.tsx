"use client";

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { useUser } from "@clerk/nextjs";
import { ThemeProvider } from "next-themes";
import { Fragment, useEffect, useMemo } from "react";
import { shouldRetryQuery } from "@/lib/api-client";

function createQueryClient() {
  return new QueryClient({
    defaultOptions: {
      // Treat fetched data as fresh for 60s so tabbing back to the app doesn't refetch every list
      // on each window focus. Mutations still invalidate affected queries explicitly.
      queries: { staleTime: 60_000, retry: shouldRetryQuery },
    },
  });
}

export default function Providers({ children }: { children: React.ReactNode }) {
  const { isLoaded, user } = useUser();
  const identityKey = isLoaded ? (user?.id ?? "anonymous") : "loading";
  // A separate client per resolved identity isolates both cached queries and late mutation
  // callbacks. An old account can only write to its retired client, never the next user's cache.
  const queryClient = useMemo(createQueryClient, [identityKey]);

  useEffect(
    () => () => {
      void queryClient.cancelQueries();
      queryClient.clear();
    },
    [queryClient],
  );

  return (
    // Dark is Dala's reference theme, so it stays the default until the user picks light or system.
    <ThemeProvider attribute="class" defaultTheme="dark" enableSystem disableTransitionOnChange>
      <QueryClientProvider client={queryClient}>
        {/* Remount local component/runtime state as well as replacing the query cache. */}
        <Fragment key={identityKey}>{children}</Fragment>
      </QueryClientProvider>
    </ThemeProvider>
  );
}
