import InquiryDetailView from '@/components/admin/InquiryDetail';
export default async function Page({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return <InquiryDetailView id={id} />;
}
