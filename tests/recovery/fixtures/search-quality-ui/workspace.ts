// Browser-only fixture. No auth credential or real DB connection is used.
export const organization = "11111111-1111-4111-8111-111111111111";
export function useWorkspace() {
  return {
    base: `/api/organizations/${organization}`,
    canWrite: true,
    profile: { id: "22222222-2222-4222-8222-222222222222" },
    refresh: async () => {},
  };
}
