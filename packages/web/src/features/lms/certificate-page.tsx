import { useQuery } from '@tanstack/react-query';
import { Link, useParams } from 'react-router-dom';

import { lmsApi } from './lms-api';

export function CertificatePage() {
  const { token = '' } = useParams();
  const result = useQuery({
    queryKey: ['lms', 'verify', token],
    queryFn: () => lmsApi.verify(token),
    retry: false,
  });
  return (
    <main className="mx-auto max-w-3xl p-6 md:p-12">
      <h1 className="text-2xl font-semibold">Verify a Sydekyks certificate</h1>
      {result.isPending ? (
        <p className="mt-6" role="status">
          Checking credential…
        </p>
      ) : result.isError ? (
        <p className="mt-6" role="alert">
          We could not verify this credential. Check the link or contact
          Sydekyks.
        </p>
      ) : (
        <section className="mt-8 space-y-4 border-y border-gray-6 py-6">
          <h2 className="text-xl font-semibold">{result.data.title}</h2>
          <p className="font-medium">Status: {result.data.status}</p>
          <dl className="grid grid-cols-[auto_1fr] gap-x-6 gap-y-3">
            <dt>Issuer</dt>
            <dd>{result.data.issuer}</dd>
            <dt>Certificate ID</dt>
            <dd className="break-all">{result.data.id}</dd>
            <dt>Issued</dt>
            <dd>{new Date(result.data.issuedAt).toLocaleDateString()}</dd>
            <dt>Expires</dt>
            <dd>{new Date(result.data.expiresAt).toLocaleDateString()}</dd>
          </dl>
          <p className="text-gray-11">{result.data.scope}</p>
          <p className="text-sm text-gray-11">
            This page verifies the credential record. Ask the holder to confirm
            that this certificate ID belongs to them.
          </p>
        </section>
      )}
      <Link
        className="mt-6 inline-block text-accent-11 underline underline-offset-4"
        to="/learn"
      >
        Go to partner learning
      </Link>
    </main>
  );
}
