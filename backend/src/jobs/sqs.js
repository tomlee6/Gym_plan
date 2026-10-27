/**
 * The jobs queue in Amazon SQS (M-04). Messages carry only the job id: the
 * jobs table is the truth, so a duplicate delivery finds the job already
 * claimed or finished and does nothing.
 */
import { DeleteMessageCommand, ReceiveMessageCommand, SendMessageCommand, SQSClient } from '@aws-sdk/client-sqs';

export class SqsQueue {
  constructor({ url, region, client }) {
    if (!url) throw new Error('JOBS_QUEUE_URL is required when QUEUE_DRIVER=sqs');
    this.url = url;
    this.client = client ?? new SQSClient({ region });
  }

  async send(body) {
    await this.client.send(new SendMessageCommand({ QueueUrl: this.url, MessageBody: JSON.stringify(body) }));
  }

  /** Long-polls for up to `max` messages: `[{ body, done() }]`. */
  async receive(max = 5) {
    const out = await this.client.send(
      new ReceiveMessageCommand({
        QueueUrl: this.url,
        MaxNumberOfMessages: max,
        WaitTimeSeconds: 20,
        // Long enough for a large scan read; a job that runs longer is
        // still safe, because the jobs table stops a second worker.
        VisibilityTimeout: 900,
      }),
    );
    return (out.Messages ?? []).map((m) => ({
      body: (() => {
        try {
          return JSON.parse(m.Body);
        } catch {
          return {};
        }
      })(),
      done: () => this.client.send(new DeleteMessageCommand({ QueueUrl: this.url, ReceiptHandle: m.ReceiptHandle })),
    }));
  }
}
