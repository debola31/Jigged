# Test Case Matrix

This matrix tracks all test cases for the Jigged application.

## Summary

- **Implemented**: 22 tests
- **Not Implemented**: 1 tests
- **Partial**: 1 tests

## Test Cases

| ID | Name | Category | Status | Input/Precondition | Pass Criteria | Fail Criteria | Test File |
|---|---|---|---|---|---|---|---|
| BL-001 | Quote rejected to pending | Business Logic | Implemented | Status change rejected to pending_approval | Transition allowed | Blocked | quotesAccess.test.ts |
| BL-002 | Quote pending to approved | Business Logic | Implemented | Status change pending to approved | Transition allowed | Blocked | quotesAccess.test.ts |
| BL-003 | Quote approved to pending (invalid) | Business Logic | Implemented | Invalid transition | Blocked with error | Allowed | quotesAccess.test.ts |
| BL-004 | Multi-tenancy isolation | Business Logic | Implemented | Query other company | Returns empty/403 | Shows other company data | companyAccess.test.ts |
| BL-005 | Last company preference | Business Logic | Implemented | User with preference | Redirects correctly | Wrong company or error | companyAccess.test.ts |
| BL-006 | Attachment limit | Business Logic | Implemented | 6th attachment | Rejected | Accepted | storageHelpers.test.ts |
| BL-007 | FK constraint violation | Business Logic | Implemented | Invalid reference | 23503 error handled | Crash or unclear error | Various access tests |
| DV-001 | Empty required fields | Data Validation | Implemented | Submit form with empty required field | Error shown, form blocked | Submits or silent fail | Various form tests |
| DV-002 | Quantity lower bound | Data Validation | Implemented | qty = 0 | Rejected with error | Accepted | quotesAccess.test.ts |
| DV-003 | Quantity upper bound | Data Validation | Implemented | qty = 1,000,001 | Rejected with error | Accepted | quotesAccess.test.ts |
| DV-004 | Price bounds | Data Validation | Implemented | price = -1 or 1,000,000 | Rejected | Accepted | quotesAccess.test.ts |
| DV-005 | Description max length | Data Validation | Implemented | 5001 chars in description | Truncated or rejected | Silently accepted | quotesAccess.test.ts |
| DV-006 | SQL injection in search | Data Validation | Implemented | Search: DROP TABLE-- | Sanitized, no error | DB error or injection works | quotesAccess.test.ts |
| DV-007 | File type validation | Data Validation | Implemented | .exe file upload | Rejected, PDF only msg | Accepted | storageHelpers.test.ts |
| DV-008 | File size limit | Data Validation | Implemented | 51MB file | Rejected with size error | Accepted | storageHelpers.test.ts |
| EH-001 | Not found error (PGRST116) | Error Handling | Implemented | Deleted resource | User-friendly not found | Raw error or crash | Various access tests |
| EH-002 | DB error | Error Handling | Implemented | Network failure | Graceful error message | Crash or timeout | Various access tests |
| EH-003 | Storage upload failure | Error Handling | Implemented | Corrupt file | Clear error message | Silent fail | storageHelpers.test.ts |
| EH-004 | Auth redirect | Error Handling | Implemented | Expired session | Redirect to login | Blank page or error | AuthGuard.test.tsx |
| IM-001 | Duplicate in DB | Import | Implemented | Existing customer code | Flagged as conflict | Silently overwrites | csvParser.test.ts |
| IM-002 | Duplicate in file | Import | Implemented | Same code twice in CSV | Both flagged | One accepted silently | csvParser.test.ts |
| IM-003 | Missing required | Import | Implemented | Row without name | Validation error | Import proceeds | csvParser.test.ts |
| IM-004 | Auto-create groups | Import | Partial | New resource group name | Created automatically | Error or ignored | Backend import tests |
| IM-005 | Large batch | Import | Not Implemented | 1000+ rows | Batched processing | Timeout or crash | TBD |
