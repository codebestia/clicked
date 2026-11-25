// @vitest-environment happy-dom
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import { ProposalCard } from './ProposalCard';

// Mock hooks and external dependencies so the component renders without providers
vi.mock('@/components/auth/useAuth', () => ({
  useAuth: () => ({ token: 'test-token' }),
}));

vi.mock('@/lib/useToast', () => ({
  useToast: () => ({ success: vi.fn(), error: vi.fn() }),
}));

vi.mock('@/lib/freighter', () => ({
  signWalletMessage: vi.fn(),
}));

vi.mock('@/lib/api', () => ({
  apiFetch: vi.fn(),
}));

const baseProposal = {
  id: '1',
  proposalId: 'P-001',
  status: 'active' as const,
  approvalsCount: 1,
  rejectionsCount: 0,
  recipient: 'GABC1234567890',
  amount: '500',
  token: 'XLM',
  threshold: 3,
  hasVoted: false,
  myVote: null,
};

describe('ProposalCard', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('renders the proposal ID and amount', () => {
    render(<ProposalCard proposal={baseProposal} />);
    expect(screen.getByText('Proposal #P-001')).toBeDefined();
    expect(screen.getByText(/500/)).toBeDefined();
    expect(screen.getByText(/XLM/)).toBeDefined();
  });

  it('shows Approve and Reject buttons for an active proposal', () => {
    render(<ProposalCard proposal={baseProposal} />);
    expect(screen.getByText('Approve')).toBeDefined();
    expect(screen.getByText('Reject')).toBeDefined();
  });

  it('disables vote buttons when the proposal is not active', () => {
    render(
      <ProposalCard
        proposal={{ ...baseProposal, status: 'approved', hasVoted: false }}
      />,
    );
    const approveBtn = screen.getByText('Approve').closest('button') as HTMLButtonElement;
    const rejectBtn = screen.getByText('Reject').closest('button') as HTMLButtonElement;
    expect(approveBtn.disabled).toBe(true);
    expect(rejectBtn.disabled).toBe(true);
  });

  it('disables vote buttons when the user has already voted', () => {
    render(
      <ProposalCard
        proposal={{ ...baseProposal, hasVoted: true }}
      />,
    );
    const approveBtn = screen.getByText('Approve').closest('button') as HTMLButtonElement;
    const rejectBtn = screen.getByText('Reject').closest('button') as HTMLButtonElement;
    expect(approveBtn.disabled).toBe(true);
    expect(rejectBtn.disabled).toBe(true);
  });

  it('displays the correct status badge for an approved proposal', () => {
    render(
      <ProposalCard proposal={{ ...baseProposal, status: 'approved' }} />,
    );
    expect(screen.getByText('Approved')).toBeDefined();
  });

  it('displays the correct status badge for an expired proposal', () => {
    render(
      <ProposalCard proposal={{ ...baseProposal, status: 'expired' }} />,
    );
    expect(screen.getByText('Expired')).toBeDefined();
  });

  it('shows the approval progress relative to threshold', () => {
    render(
      <ProposalCard
        proposal={{ ...baseProposal, approvalsCount: 2, threshold: 4 }}
      />,
    );
    expect(screen.getByText('2 / 4')).toBeDefined();
  });
});
