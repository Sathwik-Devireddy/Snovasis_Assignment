export const metadata = {
  title: "BalanceVault",
  description: "Double-entry ledger — money conserved, duplicates refused, everything auditable.",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
