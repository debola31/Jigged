"""
Customer test data factory.

Generates mock customer data for testing.
"""
from dataclasses import dataclass, field
from typing import Optional
import random
import string
import uuid


def random_string(length: int = 8) -> str:
    """Generate a random alphanumeric string."""
    return ''.join(random.choices(string.ascii_uppercase + string.digits, k=length))


def random_phone() -> str:
    """Generate a random US phone number."""
    return f"555-{random.randint(100, 999)}-{random.randint(1000, 9999)}"


def random_email(prefix: str = "test") -> str:
    """Generate a random email address."""
    return f"{prefix}.{random_string(6).lower()}@test.jigged.local"


@dataclass
class CustomerFactory:
    """
    Factory for generating customer test data.

    Usage:
        # Create with defaults
        customer = CustomerFactory()

        # Create with overrides
        customer = CustomerFactory(name="Custom Company", city="Chicago")

        # Get as dict
        customer_dict = CustomerFactory().to_dict()
    """
    id: str = field(default_factory=lambda: str(uuid.uuid4()))
    company_id: str = field(default_factory=lambda: str(uuid.uuid4()))
    customer_code: str = field(default_factory=lambda: f"CUST{random_string(4)}")
    name: str = field(default_factory=lambda: f"Test Company {random_string(4)}")
    website: Optional[str] = None
    contact_name: Optional[str] = field(default_factory=lambda: f"John {random_string(4)}")
    contact_phone: Optional[str] = field(default_factory=random_phone)
    contact_email: Optional[str] = field(default_factory=lambda: random_email("john"))
    # Address-style fields are still generated here for tests that exercise
    # the import flow (mapping CSV columns to address fields). The factory
    # exposes them via to_address_dict() and to_form_data(); to_dict() (which
    # builds the customers-table row) excludes them.
    address_line1: Optional[str] = field(default_factory=lambda: f"{random.randint(100, 9999)} Main St")
    address_line2: Optional[str] = None
    city: Optional[str] = "Springfield"
    state: Optional[str] = "IL"
    postal_code: Optional[str] = "62701"
    country: str = "USA"
    created_at: Optional[str] = None
    updated_at: Optional[str] = None

    def to_dict(self) -> dict:
        """Convert to dictionary matching the customers-table row shape."""
        return {
            "id": self.id,
            "company_id": self.company_id,
            "customer_code": self.customer_code,
            "name": self.name,
            "website": self.website,
            "contact_name": self.contact_name,
            "contact_phone": self.contact_phone,
            "contact_email": self.contact_email,
        }

    def to_address_dict(self) -> dict:
        """Convert to a customer_addresses row, tagged billing+shipping."""
        return {
            "customer_id": self.id,
            "label": "Primary",
            "address_line1": self.address_line1,
            "address_line2": self.address_line2,
            "city": self.city,
            "state": self.state,
            "postal_code": self.postal_code,
            "country": self.country,
            "is_billing": True,
            "is_shipping": True,
        }

    def to_form_data(self) -> dict:
        """Convert to form data format (no null values, empty strings instead)."""
        data = self.to_dict()
        # Remove id fields not used in forms
        del data["id"]
        del data["company_id"]
        # Convert None to empty strings
        return {k: (v or "") for k, v in data.items()}

    @classmethod
    def create_batch(cls, count: int, **overrides) -> list["CustomerFactory"]:
        """Create multiple customer instances."""
        return [cls(**overrides) for _ in range(count)]

    @classmethod
    def create_import_row(cls, **overrides) -> dict:
        """Create a row suitable for CSV import testing."""
        factory = cls(**overrides)
        return {
            "customer_code": factory.customer_code,
            "name": factory.name,
            "contact_phone": factory.contact_phone,
            "contact_email": factory.contact_email,
            "contact_name": factory.contact_name,
            "city": factory.city,
            "state": factory.state,
        }
