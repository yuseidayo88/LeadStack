import { PageHeader } from "@/components/crm/common";
import { DealsList } from "@/components/crm/deals-list";
export default function DealsPage() {
  return (
    <div className="page">
      <PageHeader
        title="商談"
        description="商談の進捗と次のアクションを確認します。"
      />
      <DealsList />
    </div>
  );
}
