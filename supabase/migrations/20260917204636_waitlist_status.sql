-- Stage A+: the waitlist status. Kept in its own file because a value added
-- with ALTER TYPE cannot be used inside the same transaction.
alter type public.registration_status add value if not exists 'waitlisted';
