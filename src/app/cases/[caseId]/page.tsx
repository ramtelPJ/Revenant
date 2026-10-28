import { LabPage } from "@/components/lab/lab-page";

export const metadata = { title: "The lab · Revenant" };

export default async function CasePage({ params }: { params: Promise<{ caseId: string }> }) {
  const { caseId } = await params;
  return <LabPage caseId={caseId} />;
}
