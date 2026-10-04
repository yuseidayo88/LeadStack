import { Suspense } from "react";
import { TasksList } from "@/components/crm/tasks-list";
import { Loading } from "@/components/crm/common";
export default function TasksPage() {
  return (
    <Suspense fallback={<Loading />}>
      <TasksList />
    </Suspense>
  );
}
