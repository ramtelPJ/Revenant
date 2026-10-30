import { VerifyPage } from "@/components/verify/verify-page";

export const metadata = { title: "Verification chamber · Revenant" };

export default async function Verify({ params }: { params: Promise<{ caseId: string }> }) {
  const { caseId } = await params;
  return <VerifyPage caseId={caseId} />;
}
