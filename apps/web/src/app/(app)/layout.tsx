import { AppShell } from '@/components/AppShell';

export default function AuthenticatedLayout({ children }: { children: React.ReactNode }): JSX.Element {
  return <AppShell>{children}</AppShell>;
}
