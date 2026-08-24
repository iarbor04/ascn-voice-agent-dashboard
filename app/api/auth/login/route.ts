import { PUT as login } from "@/app/api/auth/register/route";

export async function POST(request: Request) {
  return login(request);
}
