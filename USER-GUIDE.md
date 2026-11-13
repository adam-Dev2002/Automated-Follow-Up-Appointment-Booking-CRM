# Appoint — Appointment Booking & Follow-up Guide

Owner, staff, and customer instructions · Asia/Manila (UTC+8)

## What the system does

Appoint uses your Volt Bootstrap 5 dashboard to create and manage appointments. The connected n8n workflow validates requests, checks overlapping bookings, stores appointments in its data table, and sends confirmations and eligible reminders through Gmail.

The current dashboard runs locally at [http://localhost:3002](http://localhost:3002). It is for the business owner or staff. Create the first owner account on the setup screen, then sign in. Owners add staff accounts and read the audit log using the account button in the top bar. Separate customer accounts and a public customer booking page have not been implemented. A customer on another device cannot use your localhost address.

## Owner or staff: create an appointment

1. Keep n8n and the dashboard server running. Open the dashboard and use **Check connection**. A passing check verifies the booking API and request validation; it does not verify Gmail delivery.
2. Click **New appointment**.
3. Enter the customer's full name, email address, and service.
4. Select the date, start time, and duration. All entered times use **Asia/Manila**, even if your computer uses another timezone.
5. Click **Create appointment**. The workflow checks that the time is in the future and does not overlap another confirmed appointment. If the time is unavailable, choose another time.
6. A successful appointment appears in the list. Open its details to view the booking reference, management token, and email follow-up results.
7. If a request times out, retry the unchanged form. It reuses the request ID to avoid creating a duplicate booking.

The calendar reads the protected shared appointment source. It is not an availability picker: choosing a blank day does not guarantee every time on that day is available. The supplied workflow uses one shared calendar rather than separate staff calendars.

## Customer: request an appointment

1. Contact the business using its usual phone, message, or email channel.
2. Give your name, email address, requested service, and preferred appointment time.
3. Staff enters the booking through the dashboard.
4. When Gmail delivery is working, the workflow sends a confirmation with the service, time, booking reference, and management token.
5. Keep the reference and token private. Contact the business if you need a different time or want to cancel.

<!-- pagebreak -->

## Reschedule or cancel

1. Find the appointment using search, the status filters, or the calendar.
2. Open its details using the arrow at the end of the row.
3. Choose **Reschedule**, select a new time and duration, and save. The workflow checks for conflicts and recalculates reminder times.
4. To cancel, choose **Cancel appointment**, review the action, and submit. Cancellation stops the remaining reminders and queues a cancellation message.

Appointments that have already started cannot be rescheduled or cancelled by this workflow. A cancelled appointment cannot be rescheduled; create a new booking instead.

If the booking is not saved in this browser, use **Manage by reference** and enter its reference and 64-character management token from the confirmation email.

## Client photos and logos

Client identities use the same photo, logo, or initials across Overview, Appointments, Calendar, Clients, and Transactions. Click a linked client name or avatar to open their profile. These are client records, not separate customer sign-in accounts.

1. Open **Clients** and choose the client, or click their linked name/avatar elsewhere.
2. Under **Client photo or logo**, choose a JPG, PNG, or WebP image up to 5 MB.
3. The image is resized and saved to the client profile in the local SQLite database. It is shared across browser sessions.
4. Use **Remove photo** to restore initials. Existing browser-saved photos remain a fallback until a shared photo is saved or removed.

The app does not fetch private Google profile photos from an email address.

## Transaction history

**Transactions** opens actual payment and refund history, with one row per recorded transaction. Unpaid bookings are available under **Booking balances / Record payment**. Record only money already received or refunds already issued. Search by client, phone, email, booking reference, or receipt reference. Print any transaction using its receipt icon.

## Print or email a payment receipt

1. Open **Transactions**. Choose a transaction, or select **Booking balances / Record payment**, find the booking, and choose its payment icon.
2. Once money received or a refund has been recorded, use **Print latest receipt / Save PDF**. You can also print any individual receipt under **Receipts and refunds**.
3. The receipt opens in a separate tab. Choose your printer or **Save as PDF** in the browser's print dialog.
4. To email one receipt, choose its **Send receipt** button. Review the exact customer email, sending account, amount and receipt number, then confirm **Send receipt**.
5. Recording a payment does not automatically email it. Opening the confirmation and choosing **Go back** sends nothing.
6. **Waiting to send** and **Sending receipt** mean delivery is still in progress. **Sent by Gmail** means Gmail accepted it; it does not guarantee arrival in the customer's inbox.
7. If delivery needs review, check the sending account before sending another copy. The system does not automatically repeat an uncertain send.

Receipts show the recorded payment or refund, booking details and the balance when prepared. Internal staff notes and private booking management codes are excluded. Test bookings can be printed as test copies but cannot email receipts. This app records money paid elsewhere; it does not charge a card.

The Calendar keeps the bookings list beside the month on desktop. Scroll within that list to see more bookings without stretching the month cells. Select a day to narrow the list. On a smaller screen, the compact month appears above the scrollable list.

## Understanding your dashboard

- **Total appointments:** records saved in the current browser.
- **Upcoming:** saved confirmed appointments whose start time is still in the future.
- **Today's appointments:** saved confirmed appointments starting today in Asia/Manila.
- **Cancelled:** saved records that were cancelled.
- **Search:** matches customer name, email, service, or booking reference.
- **Calendar:** selecting a date filters the the calendar agenda. Use **Clear date** or **Today** to remove that date filter.
- **Refresh delivery:** reads current notification results from n8n for saved bookings with a management token. This requires the workflow's protected status action to be published.

The browser list is a local cache. Bookings created elsewhere and external changes do not automatically populate it. Clearing browser storage removes the local list, legacy browser photos, and saved tokens; it does not delete the actual n8n bookings.

<!-- pagebreak -->

## Automated confirmations and reminders

The workflow queues a confirmation after a new booking, reschedule, or cancellation. It checks due notifications every minute and schedules a 24-hour reminder and a 1-hour reminder for eligible confirmed appointments.

Emails include the Appoint logo, bold service details, a highlighted appointment date and time, booking reference, and clear instructions. Customers can reply with their booking reference and requested change; staff reviews the reply and updates the dashboard. Email replies are not automatically processed as booking changes.

For a Monday 10:00 AM appointment booked several days ahead, reminders are due Sunday at 10:00 AM and Monday at 9:00 AM. All of these times use Asia/Manila.

A reminder whose deadline has already passed when booking is skipped. For example, an appointment booked two hours ahead can receive its 1-hour reminder but skips the 24-hour reminder. Stopping the computer, Docker, or n8n prevents local scheduled follow-ups from running.

## What delivery labels mean

- **Queued / pending:** the message is waiting for processing.
- **Sending:** a workflow execution has claimed the message.
- **Sent by Gmail:** Gmail returned a message ID. This confirms Gmail accepted the send request; it does not confirm arrival in the recipient's inbox.
- **Email failed:** sending failed. Open appointment details for the recorded error and inspect the n8n execution.
- **Test delivery:** the workflow simulated sending to a reserved test address. No real email was sent.
- **Skipped: booked late:** the reminder deadline had already passed.
- **Cancelled:** the reminder was stopped after cancellation.
- **Not checked:** the dashboard has no current notification result. Click **Refresh delivery**.

A successful workflow execution can still contain a failed email because the workflow records Gmail errors and continues. Check the notification result, not only the overall execution's green success label.

## Troubleshooting follow-ups

1. In n8n, make sure the appointment workflow is published or active.
2. Open **Executions** and select a recent scheduled run. Check that **Every minute in Manila** is running.
3. Inspect **Gmail appointment email**, **Record delivery result**, and **Save delivery tracking** for an actual due message.
4. If the error says **Client authentication failed**, reconnect the Gmail credential using the next page.
5. After fixing Gmail, inspect failed messages before retrying. Failed notifications are not automatically retried by the current workflow. A connection check alone does not resend them.

Addresses at example.com, example.org, example.net, and domains ending in .test or .invalid simulate email delivery. Use a real address you control for a real email test.

<!-- pagebreak -->

## Reconnect Gmail in n8n

1. Open [n8n](http://localhost:5678) and select your appointment workflow.
2. Double-click **Gmail appointment email**.
3. Edit the **Gmail account** credential using the pencil button.
4. Click **Sign in with Google** or **Reconnect**, select the sending account, approve access, and save. The sending account can be different from the customer or test recipient.

If authentication still fails, check the Google OAuth configuration:

5. Open [Google Cloud Console](https://console.cloud.google.com/) and select the project that owns the OAuth client used by n8n.
6. Enable the **Gmail API** for that project.
7. Open **Google Auth Platform → Clients**, or **APIs & Services → Credentials**, and select the correct **Web application** OAuth client.
8. Copy the current Client ID and Client Secret into the n8n credential. Keep the secret inside n8n and Google Cloud.
9. Copy the exact **OAuth Redirect URL displayed by n8n** into the client's authorized redirect URIs. For the local setup, it is normally **http://localhost:5678/rest/oauth2-credential/callback**.
10. If the Google app is in **Testing**, add the sending Google account under **Audience → Test users**.
11. Sign in again from the n8n credential and save. If the workflow is inactive or has unpublished changes, publish it after saving.
12. Run a clearly labelled test booking to an address you control. Verify the Gmail node returns a message ID, the appointment notification is marked sent, and the message arrives in the test inbox.

Official setup references: [n8n Google OAuth2 credentials](https://docs.n8n.io/integrations/builtin/credentials/google/oauth-single-service/), [Google OAuth client setup](https://developers.google.com/workspace/guides/create-credentials), and [Google Gmail API setup](https://developers.google.com/workspace/gmail/api/quickstart/js).

## Start the local dashboard again

Open PowerShell in the project directory. Run **npm.cmd install** once if dependencies are missing, then **npm.cmd run dev**. Visit **http://localhost:3002**. Keep the terminal open; use Ctrl+C to stop it.

Source edits rebuild automatically. Refresh the page after the terminal reports that the dashboard was updated. Your saved browser data remains available when you use the same origin and browser profile.

## What is still outside this local version

Public customer self-booking, a complete shared listing in the original calendar/overview, business-hour rules, staff calendars, online card charging, and guaranteed email receipt are not part of the current implementation. Owner/staff authentication, readable activity history, Clients, payment recording in PHP, Reports, and Excel/CSV downloads are available. Use [the testing guide](TESTING-GUIDE.md) and [setup instructions](docs/SETUP.md) for the current screens.

This guide describes the actual dashboard and workflow behavior. Delivery must be verified using the live notification results and your test inbox.
