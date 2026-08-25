import { SNSClient, PublishCommand } from "@aws-sdk/client-sns";

// Exported so tests can stub .send, the same way lib/rate-limit.ts exports
// cloudwatch for that purpose. Nothing in app code should import this client
// directly — go through publishAlert.
export const sns = new SNSClient({
  region: process.env.AWS_REGION ?? "us-east-1",
});

function getAlertsTopicArn(): string {
  const arn = process.env.SNS_ALERTS_TOPIC_ARN;
  if (!arn) throw new Error("SNS_ALERTS_TOPIC_ARN not set");
  return arn;
}

// Fire-and-forget by design (KAN-43): a broken SNS topic must never fail the
// request that triggered the alert. Callers wrap this in their own try/catch
// per the ticket, but publishAlert also never rejects on its own — it only
// logs — so a caller forgetting the try/catch still can't crash the request.
export async function publishAlert(subject: string, message: string): Promise<void> {
  try {
    await sns.send(
      new PublishCommand({
        TopicArn: getAlertsTopicArn(),
        Subject: subject,
        Message: message,
      })
    );
  } catch (err) {
    console.error("failed to publish alert to SNS", { subject, err });
  }
}
