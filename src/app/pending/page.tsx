export default function PendingPage() {
  return (
    <div style={{ maxWidth: 520, margin: "64px auto", padding: 24 }}>
      <h1 style={{ fontSize: 24, fontWeight: 700, marginBottom: 12 }}>
        승인 대기 중
      </h1>
      <p style={{ color: "#555", lineHeight: 1.6 }}>
        계정이 아직 승인되지 않았어요. 관리자가 승인하면 이용할 수 있습니다.
      </p>
    </div>
  );
}
