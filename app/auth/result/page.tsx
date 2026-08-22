import { AuthResultContent } from "@/components/auth/AuthResultContent";
import type { AuthResultType } from "@/lib/auth";

const validResultTypes = new Set<AuthResultType>([
  "account_not_found",
  "already_registered",
  "signup_success",
  "login_error",
]);

function getResultType(value: string | string[] | undefined): AuthResultType {
  return typeof value === "string" && validResultTypes.has(value as AuthResultType)
    ? value as AuthResultType
    : "login_error";
}

export default async function AuthResultPage({ searchParams }: PageProps<"/auth/result">) {
  const params = await searchParams;
  return <AuthResultContent type={getResultType(params.type)} />;
}
