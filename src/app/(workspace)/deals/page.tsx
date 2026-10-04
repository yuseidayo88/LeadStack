import { PageHeader } from "@/components/crm/common";
import { DealsList } from "@/components/crm/deals-list";
export default function DealsPage() {
  return (
    <div className="page">
      <PageHeader
        title="商談"
        description="ヒアリングから成約まで、チームの進捗をひと目で。"
      />
      <DealsList />
    </div>
  );
}
