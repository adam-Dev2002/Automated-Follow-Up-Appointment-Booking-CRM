# Test the current Appoint dashboard

The current version supports owner/staff sign-in, account management, readable activity history, manual booking, rescheduling, cancellation, client profiles/history, PHP payment records, revenue reports, and Excel/CSV downloads. Done/Completed, No-show, delete/restore, public self-booking, staff availability rules, and the other audited gaps remain queued. This guide tests the features that are available now.

## 1. Sign in and find your account

1. Open **http://localhost:3002** and sign in with your owner username and password. Your owner account already exists if you see your name in the top-right corner.
2. Refresh the page. Expect your appointments and signed-in session to remain available in the same browser.
3. Click your name/avatar in the top-right corner. **Accounts** manages staff and owners; **Audit log** shows activity history.

Each user now has a colored avatar with their initials, such as **DO** for Demo Owner. The same person has the same avatar in the toolbar, account list, and activity history. These are automatic initial avatars; no photo upload is required.

## 2. Add and test a staff account

1. In **Accounts**, enter a test staff name, a unique username such as `test-staff`, and a password of at least 12 characters. Leave the role as **Staff** and click **Add account**.
2. Expect the account to appear in the list with an avatar, username, Staff role, and Active access.
3. Open a private/incognito window, visit the same dashboard address, and sign in as that staff member.
4. Click the staff avatar. Expect their account identity and Sign out button. Owner-only Accounts and Audit log controls should be absent.
5. Keep the private window open for step 3. Bookings remain specific to the browser in this version, so this window will not automatically show the owner's cached appointment list.

## 3. Test account action confirmations

1. Return to the owner's normal browser window and open **Accounts**.
2. Find the test staff member and click **Disable**. Click **Go back** in the confirmation. Expect their account to remain Active and their session to remain valid.
3. Click **Disable** again, then **Confirm change**. Expect the account to show Disabled.
4. In the staff window, refresh or make a request. Expect sign-in to be required again. That account must not be able to sign in while disabled.
5. As owner, click **Enable** and confirm. Expect staff sign-in to work again.
6. To test password reset, reset only the test staff account, confirm, then try signing in with its old and new passwords. Expect only the new password to work.
7. The system prevents you from disabling or demoting the only active owner.

## 4. Find booking actions

1. Close the account window and open **Appointments** from the left navigation.
2. Find an appointment and click the **arrow at the far right of its row**.
3. In Appointment details, look at the bottom: **Reschedule** and **Cancel appointment** are available for a confirmed appointment that has not started and has its management token saved.
4. If its token is missing, choose **Enter management token**. **Manage by reference** above the list also accepts a booking reference and its private token.
5. Cancelled and already-started appointments do not show reschedule/cancel buttons. **Payment** remains available so an owner can record a refund. Done, No-show, Duplicate, and Delete/Restore are not available yet.

## 5. Create a safe test booking

1. Click **New appointment**.
2. Enter a recognizable test customer name, **test@example.test**, and a service such as **Test consultation**. This reserved test address uses the existing workflow's test delivery behavior.
3. Choose an unused future date/time and a 30-minute duration. All times are shown in **Asia/Manila (UTC+8)**.
4. Click **Create appointment**. Expect the details to open with a booking reference and Confirmed status.
5. Note the reference. Refresh the page; expect the booking to remain in this browser's list. Search for the test name or reference to find it again.
6. Creating the appointment does not charge money. Use its **Payment** action or the **Transactions** navigation item to record a payment separately.

## 6. Check conflict prevention and rescheduling

1. Start another test booking using exactly the same time as the first. Expect a conflict message and no extra saved booking.
2. Close that form. Open the original test booking's details and click **Reschedule**.
3. Choose another unused future time and save. Expect its displayed time to change while its reference stays the same.
4. Refresh and reopen it. Expect the new time to remain saved.

## 7. Cancel and verify it was retained

1. Open the test booking's details and click **Cancel appointment**.
2. Review the cancellation screen and confirm the cancellation.
3. In the appointment list, choose **Cancelled**. Expect the booking to remain visible with Cancelled status, including after a refresh.
4. Cancelled bookings are **not automatically deleted**. Their former time stops blocking a new booking. There is no automatic deletion or delete/restore action yet.
5. If you want to verify slot reuse, create a separate test booking in that former time, then cancel that new test booking when finished.

## 8. Read the activity history

1. Click your owner avatar/name, then **Audit log**.
2. Expect readable actions such as **Signed in**, **Added an account**, **Disabled an account**, **Created a booking**, **Rescheduled a booking**, and **Cancelled a booking**.
3. Expect each row to show a user avatar/name, role, time, result, and the affected account or booking reference.
4. Expand **See what changed** on a booking/account change. Expect labeled values such as **Start time — Previous / Now**, rather than JSON or `null` values. View-only events show **No changes made**.
5. Enter the test booking's reference and click **Refresh log**. Expect its recorded booking changes to appear.
6. **Successful** in this activity table means the recorded action succeeded. It does not mean an appointment was marked Done. **Needs review** means the requested change has no recorded final result.
7. History starts when audit logging was installed. Older bookings do not have reconstructed historical events.

## User database

**Yes, the user database was created.** Owner/staff accounts, hashed passwords, sessions, and account activity are saved in **`.local/access.sqlite`**. Appointment records and booking activity stay in their existing n8n data tables. You do not need to create the user database manually.

## 9. Test the client manager

1. Open **Clients** in the left navigation. Clients from existing bookings are linked automatically by email, so their history is available in another signed-in browser too.
2. Search by client name, email, or phone digits. Open **Profile & history** on the test client. Expect every linked booking, its current status, payment status, and payment history.
3. Add or correct their phone/email and click **Save client**. Reopen the profile and verify the saved contact details.
4. Click **Add client** to add a client without a booking. Enter a name and at least one contact method. They should appear in the list with an initials avatar and an empty booking history.
5. A duplicate email is rejected so you can use the existing profile. Blocking/merging clients and internal notes/tags belong to later batches.

## 10. Test payment forms in PHP

Use a clearly labeled test booking for sample amounts. In **Transactions**, choose **Booking balances / Record payment** to find bookings created with `test@example.test`. All bookings are included.

1. Choose **Payment details** on your test booking, or use **Payment** inside its appointment details. Expect price, retained amount, balance, and a receipt history. Existing bookings have **Price not set** until you set one.
2. Enter **1000.00** as the appointment price, click **Save price**, then choose **Go back** in the review dialog. Expect no price change. Repeat and confirm; expect a PHP 1,000 price and PHP 1,000 balance.
3. Choose **Deposit**, enter **300.00**, select a method, add a reference such as `TEST-DEP-001`, and review/confirm. Expect a PHP 300 retained amount and PHP 700 balance.
4. Record **Partial payment: 200.00**. Expect PHP 500 retained and PHP 500 balance.
5. Choose **Full payment**. Its amount should fill with the remaining **500.00**. Confirm; expect Paid status and zero balance. Entering another payment above the balance must fail.
6. As owner, choose **Record refund**, select the original receipt, enter **100.00**, and review/confirm. Expect PHP 100 refunded, PHP 900 retained, and PHP 100 balance. A refund cannot exceed that receipt's remaining refundable amount. Staff cannot record refunds.
7. Refresh and reopen the payment. Expect the same totals and all four receipt/refund rows. **Audit log**, filtered by the booking reference, should include the price and payment changes.
8. These forms record payments/refunds made elsewhere. They do not charge cards, transfer money, or ask for card numbers/CVCs. All matching records, including test bookings and their transactions, are included by default.

## 11. Test Reports and Excel downloads

1. Sign in as owner and open **Reports**. Set a date range that includes your payment date, then click **Apply filters**. All matching test records are included automatically.
2. Expect **Received: PHP 1,000**, **Refunded: PHP 100**, and **Net receipts: PHP 900** for that test flow, plus any other records in your selected range.
3. Switch Recorded revenue between **By day**, **By month**, and **By service**. Expect the same underlying receipts/refunds grouped accordingly.
4. Booking counts, top services, and busiest times use appointment start dates. Clear the date fields and reapply to include all scheduled dates. Cancelled bookings are excluded from top services/busiest times.
5. Click **Download full Excel report**. Open the `.xlsx` file in Excel. It contains Appointments, Clients, Payments, three revenue tables, Top services, Busiest times, and Report info.
6. Under **Export a table**, choose Appointments, Clients, or Payment records and download **Excel** or **CSV**. Expect the matching records with readable headers; money in Excel is numeric. Private management tokens and passwords are excluded.
7. Client downloads include matching contacts without requiring a booking in the selected date range. Contacts with test bookings are included as well.
8. Staff should have no Reports navigation entry. Direct report/export requests are rejected by the server.

## 12. Shared client photo and transaction history

1. Open a linked client name/avatar and upload a PNG, JPEG, or WebP photo/logo.
2. Check the same client in Overview, Appointments, Calendar, Clients, and Transactions. The same saved image should appear.
3. Refresh or use a second signed-in browser session; the client image should persist.
4. Transaction history has one row per receipt/refund. Unpaid bookings appear under Booking balances / Record payment.
5. A refund displays as a negative amount without rewriting its original receipt.

## Automated verification

From the project folder, run:

```powershell
npm.cmd run test:security
npm.cmd run test:access
npm.cmd run test:dashboard
npm.cmd run test:crm
npm.cmd run test:transactions
npm.cmd run test:receipts
npm.cmd run test:calendar
```

These checks use disposable accounts and stubbed/intercepted booking writes. They do not create accounts in your real user database or change your real appointments. The access check saves desktop/mobile previews in `.local/verification/`.
