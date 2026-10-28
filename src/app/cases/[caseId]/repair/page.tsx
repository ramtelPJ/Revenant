import { RepairPage } from "@/components/repair/repair-page";

export const metadata = { title: "Repair lab · Revenant" };

export default async function Repair({ params }: { params: Promise<{ caseId: string }> }) {
  const { caseId } = await params;
  return <RepairPage caseId={caseId} />;
}
