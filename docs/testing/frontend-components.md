# Frontend Component Tests

## Testing Patterns

Tests should read like documentation. Use descriptive names that explain the expected behavior.

---

## CustomerForm Tests

Create `__tests__/components/customers/CustomerForm.test.tsx`:

```typescript
import { describe, it, expect, vi } from 'vitest'
import { render, screen, waitFor } from '../../test-utils'
import userEvent from '@testing-library/user-event'
import { CustomerForm } from '@/components/customers/CustomerForm'
import { server } from '../../mocks/server'
import { http, HttpResponse } from 'msw'

describe('CustomerForm', () => {
  const defaultProps = {
    companyId: 'test-company',
    onSuccess: vi.fn(),
    onCancel: vi.fn(),
  }

  describe('validation', () => {
    it('shows error when customer_code is empty', async () => {
      const user = userEvent.setup()
      render(<CustomerForm {...defaultProps} />)
      
      await user.type(
        screen.getByLabelText(/company name/i), 
        'Acme Corp'
      )
      await [user.click](http://user.click/)(
        screen.getByRole('button', { name: /save/i })
      )
      
      expect(
        await screen.findByText(/customer code.*required/i)
      ).toBeInTheDocument()
    })

    it('shows error when name is empty', async () => {
      const user = userEvent.setup()
      render(<CustomerForm {...defaultProps} />)
      
      await user.type(
        screen.getByLabelText(/customer code/i), 
        'ACME01'
      )
      await [user.click](http://user.click/)(
        screen.getByRole('button', { name: /save/i })
      )
      
      expect(
        await screen.findByText(/name.*required/i)
      ).toBeInTheDocument()
    })
  })

  describe('create mode', () => {
    it('creates customer and calls onSuccess', async () => {
      const user = userEvent.setup()
      const onSuccess = vi.fn()
      render(
        <CustomerForm {...defaultProps} onSuccess={onSuccess} />
      )
      
      await user.type(
        screen.getByLabelText(/customer code/i), 
        'NEW01'
      )
      await user.type(
        screen.getByLabelText(/company name/i), 
        'New Corp'
      )
      await [user.click](http://user.click/)(
        screen.getByRole('button', { name: /save/i })
      )
      
      await waitFor(() => {
        expect(onSuccess).toHaveBeenCalledWith(
          expect.objectContaining({
            customer_code: 'NEW01',
            name: 'New Corp'
          })
        )
      })
    })

    it('shows API error for duplicate code', async () => {
      const user = userEvent.setup()
      render(<CustomerForm {...defaultProps} />)
      
      await user.type(
        screen.getByLabelText(/customer code/i), 
        'DUPE01'
      )
      await user.type(
        screen.getByLabelText(/company name/i), 
        'Dupe Corp'
      )
      await [user.click](http://user.click/)(
        screen.getByRole('button', { name: /save/i })
      )
      
      expect(
        await screen.findByText(/already exists/i)
      ).toBeInTheDocument()
    })
  })

  describe('edit mode', () => {
    it('pre-fills form with existing data', () => {
      const customer = {
        id: '123',
        customer_code: 'EXIST01',
        name: 'Existing Corp',
        phone: '555-1234'
      }
      
      render(
        <CustomerForm {...defaultProps} customer={customer} />
      )
      
      expect(
        screen.getByLabelText(/customer code/i)
      ).toHaveValue('EXIST01')
      expect(
        screen.getByLabelText(/company name/i)
      ).toHaveValue('Existing Corp')
    })
  })
})
```

---

## CustomerList Tests

Create `__tests__/components/customers/CustomerList.test.tsx`:

```typescript
import { describe, it, expect } from 'vitest'
import { render, screen, waitFor } from '../../test-utils'
import userEvent from '@testing-library/user-event'
import { CustomerList } from '@/components/customers/CustomerList'

describe('CustomerList', () => {
  it('displays customers from API', async () => {
    render(<CustomerList companyId="test" />)
    
    expect(
      await screen.findByText('Acme Corp')
    ).toBeInTheDocument()
    expect(
      screen.getByText('Ajax Inc')
    ).toBeInTheDocument()
  })

  it('filters customers by search term', async () => {
    const user = userEvent.setup()
    render(<CustomerList companyId="test" />)
    
    await screen.findByText('Acme Corp')
    
    await user.type(
      screen.getByPlaceholderText(/search/i),
      'Acme'
    )
    
    await waitFor(() => {
      expect(screen.getByText('Acme Corp')).toBeInTheDocument()
      expect(screen.queryByText('Ajax Inc')).not.toBeInTheDocument()
    })
  })

  it('shows empty state when no customers', async () => {
    server.use(
      http.get('/api/customers', () => {
        return HttpResponse.json({ data: [] })
      })
    )
    
    render(<CustomerList companyId="test" />)
    
    expect(
      await screen.findByText(/no customers/i)
    ).toBeInTheDocument()
  })
})
```

---

## Import Components Tests

Create `__tests__/components/customers/import/ConfidenceChip.test.tsx`:

```typescript
import { describe, it, expect } from 'vitest'
import { render, screen } from '../../../test-utils'
import { ConfidenceChip } from '@/components/customers/import/ConfidenceChip'

describe('ConfidenceChip', () => {
  it('shows green for high confidence (>=0.8)', () => {
    render(<ConfidenceChip confidence={0.95} />)
    
    const chip = screen.getByTestId('confidence-chip')
    expect(chip).toHaveAttribute('data-confidence', 'high')
  })

  it('shows yellow for medium confidence (0.5-0.79)', () => {
    render(<ConfidenceChip confidence={0.65} />)
    
    const chip = screen.getByTestId('confidence-chip')
    expect(chip).toHaveAttribute('data-confidence', 'medium')
  })

  it('shows red for low confidence (<0.5)', () => {
    render(<ConfidenceChip confidence={0.3} />)
    
    const chip = screen.getByTestId('confidence-chip')
    expect(chip).toHaveAttribute('data-confidence', 'low')
  })
})
```
