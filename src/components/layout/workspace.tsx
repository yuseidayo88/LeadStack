"use client";
import {
  createContext,
  useContext,
  useEffect,
  useState,
  useSyncExternalStore,
  type ReactNode,
  type CSSProperties,
} from "react";
import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { SWRConfig, useSWRConfig } from "swr";
import {
  Building2,
  LayoutDashboard,
  Handshake,
  ListTodo,
  Settings,
  Layers,
  Menu,
  LogOut,
  ChevronsUpDown,
  Plus,
  Check,
  Search,
} from "lucide-react";
import { api, useApi, message } from "@/lib/client-api";
import type { Tables } from "@/lib/database.types";
import { type Organization, type Member, roleLabels } from "@/lib/crm/display";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import {
  Sheet,
  SheetContent,
  SheetTitle,
  SheetTrigger,
} from "@/components/ui/sheet";
import {
  DropdownMenu,
  DropdownMenuTrigger,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuLabel,
} from "@/components/ui/dropdown-menu";
import { Avatar, AvatarFallback } from "@/components/ui/avatar";
import { ErrorState, Loading } from "@/components/crm/common";
import { toast, Toaster } from "sonner";
type Context = {
  org: Organization;
  organizations: Organization[];
  profile: Tables<"profiles">;
  members: Member[];
  canWrite: boolean;
  isAdmin: boolean;
  selectOrg: (id: string) => void;
  refresh: () => Promise<void>;
  base: string;
};
const Workspace = createContext<Context | null>(null);
export function useWorkspace() {
  const value = useContext(Workspace);
  if (!value) throw new Error("Workspace missing");
  return value;
}
const storageKey = "leadstack.organization";
const subscribe = (cb: () => void) => {
  window.addEventListener("storage", cb);
  window.addEventListener("leadstack-org", cb);
  return () => {
    window.removeEventListener("storage", cb);
    window.removeEventListener("leadstack-org", cb);
  };
};
export function selectOrganization(id: string) {
  try {
    localStorage.setItem(storageKey, id);
  } catch {}
  window.dispatchEvent(new Event("leadstack-org"));
}
const getSnapshot = () => {
  try {
    return localStorage.getItem(storageKey) || "";
  } catch {
    return "";
  }
};
const getServerSnapshot = () => "";
export function WorkspaceProvider({ children }: { children: ReactNode }) {
  return (
    <SWRConfig value={{ provider: () => new Map(), revalidateOnFocus: true }}>
      <WorkspaceLoader>{children}</WorkspaceLoader>
      <Toaster
        position="bottom-right"
        theme="light"
        richColors
        closeButton
        containerAriaLabel="通知"
        toastOptions={{ closeButtonAriaLabel: "通知を閉じる" }}
        style={
          {
            "--success-bg": "#f0fdfa",
            "--success-border": "#99f6e4",
            "--success-text": "#115e59",
          } as CSSProperties
        }
      />
    </SWRConfig>
  );
}
function WorkspaceLoader({ children }: { children: ReactNode }) {
  const organizations = useApi<{ data: Organization[] }>("/api/organizations");
  const profile = useApi<{ data: Tables<"profiles"> }>("/api/profile");
  const selected = useSyncExternalStore(
    subscribe,
    getSnapshot,
    getServerSnapshot,
  );
  const router = useRouter();
  const { mutate } = useSWRConfig();
  const org =
    organizations.data?.data.find((o) => o.id === selected) ||
    organizations.data?.data[0];
  const members = useApi<{ data: Member[] }>(
    org ? `/api/organizations/${org.id}/members` : null,
  );
  useEffect(() => {
    if (organizations.data && !organizations.data.data.length)
      router.replace("/onboarding");
  }, [organizations.data, router]);
  const error = organizations.error || profile.error || members.error;
  if (error)
    return (
      <div className="mx-auto max-w-xl p-8">
        <ErrorState
          error={error}
          retry={() => {
            void organizations.mutate();
            void profile.mutate();
            void members.mutate();
          }}
        />
      </div>
    );
  if (!org || !profile.data || !members.data) return <Loading />;
  const refresh = async () => {
    await mutate(
      (key: unknown) =>
        typeof key === "string" &&
        (key.startsWith(`/api/organizations/${org.id}/`) ||
          key === "/api/organizations" ||
          key === "/api/profile"),
    );
  };
  return (
    <Workspace.Provider
      value={{
        org,
        organizations: organizations.data!.data,
        profile: profile.data.data,
        members: members.data.data,
        canWrite: org.role !== "viewer",
        isAdmin: ["owner", "admin"].includes(org.role),
        selectOrg: selectOrganization,
        refresh,
        base: `/api/organizations/${org.id}`,
      }}
    >
      <WorkspaceShell key={org.id}>{children}</WorkspaceShell>
    </Workspace.Provider>
  );
}
const nav = [
  { href: "/dashboard", label: "ダッシュボード", icon: LayoutDashboard },
  { href: "/companies", label: "企業", icon: Building2 },
  { href: "/discover", label: "企業を探す", icon: Search },
  { href: "/deals", label: "商談", icon: Handshake },
  { href: "/tasks", label: "タスク", icon: ListTodo },
];
function Navigation({ close }: { close?: () => void }) {
  const pathname = usePathname();
  const { org, organizations, selectOrg } = useWorkspace();
  return (
    <div className="flex h-full flex-col">
      <Link
        href="/dashboard"
        onClick={close}
        className="flex h-16 items-center gap-2.5 px-5 text-lg font-semibold tracking-tight"
      >
        <div className="rounded-md bg-primary p-1.5 text-white">
          <Layers className="size-5" />
        </div>
        LeadStack
      </Link>
      <div className="px-3 pb-6">
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button
              variant="outline"
              className="h-12 w-full justify-between bg-white px-3"
            >
              <span className="truncate">{org.name}</span>
              <ChevronsUpDown className="size-4 text-muted-foreground" />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent className="w-64" align="start">
            <DropdownMenuLabel>ワークスペース</DropdownMenuLabel>
            {organizations.map((o) => (
              <DropdownMenuItem
                key={o.id}
                onSelect={() => {
                  selectOrg(o.id);
                  close?.();
                }}
              >
                <span className="truncate">{o.name}</span>
                {o.id === org.id && <Check className="ml-auto size-4" />}
              </DropdownMenuItem>
            ))}
            <DropdownMenuSeparator />
            <DropdownMenuItem asChild>
              <Link href="/onboarding">
                <Plus />
                組織を作成・招待を確認
              </Link>
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </div>
      <p className="px-5 pb-2 text-[10px] font-semibold tracking-[0.15em] text-muted-foreground">
        WORKSPACE
      </p>
      <nav aria-label="メインナビゲーション" className="space-y-1 px-3">
        {nav.map(({ href, label, icon: Icon }) => (
          <Link
            key={href}
            href={href}
            onClick={close}
            aria-current={pathname.startsWith(href) ? "page" : undefined}
            className={cn(
              "flex items-center gap-3 rounded-md px-3 py-2.5 font-medium text-slate-600 hover:bg-muted",
              pathname.startsWith(href) && "bg-accent text-accent-foreground",
            )}
          >
            <Icon className="size-[18px]" />
            {label}
          </Link>
        ))}
      </nav>
      <div className="mt-auto border-t p-3">
        <Link
          href="/settings"
          onClick={close}
          aria-current={pathname.startsWith("/settings") ? "page" : undefined}
          className={cn(
            "flex items-center gap-3 rounded-md px-3 py-2.5 text-slate-600 hover:bg-muted",
            pathname.startsWith("/settings") &&
              "bg-accent text-accent-foreground",
          )}
        >
          <Settings className="size-[18px]" />
          設定
        </Link>
        <p className="px-3 pb-1 pt-5 text-xs text-muted-foreground">
          営業の次の一手を、ここから。
        </p>
      </div>
    </div>
  );
}
function WorkspaceShell({ children }: { children: ReactNode }) {
  const router = useRouter();
  const { profile, org } = useWorkspace();
  const pathname = usePathname();
  const [mobile, setMobile] = useState(false);
  const [busy, setBusy] = useState(false);
  const title = nav.find((n) => pathname.startsWith(n.href))?.label || "設定";
  async function logout() {
    setBusy(true);
    try {
      await api("/api/auth/logout", "POST", {});
      router.replace("/login");
      router.refresh();
    } catch (e) {
      toast.error(message(e));
      setBusy(false);
    }
  }
  return (
    <div className="min-h-screen">
      <a
        href="#main"
        className="sr-only z-50 bg-white p-3 focus:not-sr-only focus:fixed"
      >
        本文へスキップ
      </a>
      <aside className="fixed inset-y-0 left-0 z-30 hidden w-[232px] border-r bg-white lg:block">
        <Navigation />
      </aside>
      <div className="min-w-0 lg:pl-[232px]">
        <header className="sticky top-0 z-20 flex h-14 items-center justify-between gap-4 border-b bg-white/95 px-4 backdrop-blur md:px-7">
          <div className="flex items-center gap-3">
            <Sheet open={mobile} onOpenChange={setMobile}>
              <SheetTrigger asChild>
                <Button
                  variant="ghost"
                  size="icon"
                  className="lg:hidden"
                  aria-label="メニューを開く"
                >
                  <Menu />
                </Button>
              </SheetTrigger>
              <SheetContent side="left" className="w-[270px] p-0">
                <SheetTitle className="sr-only">ナビゲーション</SheetTitle>
                <Navigation close={() => setMobile(false)} />
              </SheetContent>
            </Sheet>
            <span className="text-xs text-muted-foreground">
              ワークスペース <span className="mx-2 text-slate-300">/</span>
              <span className="text-foreground">{title}</span>
            </span>
          </div>
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button variant="ghost" className="gap-2 px-1.5">
                <Avatar className="size-7">
                  <AvatarFallback className="bg-teal-100 text-xs text-teal-800">
                    {profile.name.slice(0, 1)}
                  </AvatarFallback>
                </Avatar>
                <span className="hidden max-w-32 truncate text-xs sm:inline">
                  {profile.name}
                </span>
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end">
              <DropdownMenuLabel>
                {profile.name}
                <p className="mt-1 text-xs font-normal text-muted-foreground">
                  {roleLabels[org.role]}
                </p>
              </DropdownMenuLabel>
              <DropdownMenuItem asChild>
                <Link href="/settings">プロフィール・設定</Link>
              </DropdownMenuItem>
              <DropdownMenuSeparator />
              <DropdownMenuItem disabled={busy} onSelect={() => void logout()}>
                <LogOut />
                ログアウト
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        </header>
        <main id="main" tabIndex={-1}>
          {children}
        </main>
      </div>
    </div>
  );
}
