# This module is used to initialize and connect to the PostgresSQL database.
import datetime
from sqlalchemy import create_engine, Column, String, INT, DateTime
from sqlalchemy.orm import declarative_base, sessionmaker
from pydantic_settings import BaseSettings, SettingsConfigDict
from contextlib import contextmanager
# defining the setup


class Settings(BaseSettings):
    data_url: str
    model_config = SettingsConfigDict(env_file=".env")


DB_URL = Settings().data_url
try:
    engine = create_engine(DB_URL)
    print("Connection established")
except Exception as e:
    print(f"Failed, reason: {e}")
Base = declarative_base()
Session = sessionmaker(bind=engine)

# defining tables


class Log(Base):
    __tablename__ = "logs"

    ID = Column(INT, primary_key=True)
    created_at = Column(DateTime(timezone=True))
    user_id = Column(INT)
    food = Column(String)

    def __repr__(self):
        return f"ID: {self.ID}, created_at: {self.created_at}, user_id: {self.user_id} food: {self.food}"

# Setup functions

@contextmanager
def open_session():
    session = Session()
    try:
        yield session
    finally:
        session.close()
