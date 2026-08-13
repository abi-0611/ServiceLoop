import { redirect } from 'next/navigation';
import { isSignedIn } from '@/lib/api';

export const dynamic = 'force-dynamic';

export default async function HomePage(): Promise<never> {
  redirect((await isSignedIn()) ? '/board' : '/login');
}
