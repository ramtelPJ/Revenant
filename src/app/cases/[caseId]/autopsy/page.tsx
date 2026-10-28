import { AutopsyPage } from "@/components/autopsy/autopsy-page";

export const metadata = { title: "Digital autopsy · Revenant" };

export default async function Autopsy({ params }: { params: Promise<{ caseId: string }> }) {
  const { caseId } = await params;
  return <AutopsyPage caseId={caseId} />;
}
