import { ReportPage } from "@/components/report/report-page";

export const metadata = { title: "Resurrection report · Revenant" };

export default async function Report({ params }: { params: Promise<{ caseId: string }> }) {
  const { caseId } = await params;
  return <ReportPage caseId={caseId} />;
}
